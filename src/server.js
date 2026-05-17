'use strict'

require('dotenv').config()

const Fastify = require('fastify')
const { PrismaClient } = require('@prisma/client')
const jwt = require('jsonwebtoken')
const axios = require('axios')

const prisma = new PrismaClient()
const app = Fastify({ logger: true })

// ─── Registro do plugin JWT ────────────────────────────────────────────────────
app.register(require('@fastify/jwt'), {
  secret: process.env.JWT_SECRET,
})

// ─── Decorador de autenticação ─────────────────────────────────────────────────
app.decorate('autenticar', async function (request, reply) {
  try {
    await request.jwtVerify()
  } catch {
    reply.code(401).send({ message: 'Token inválido ou expirado.' })
  }
})

// ─── Token interno para chamar ms-pedidos (role ADMIN) ─────────────────────────
function gerarTokenServico() {
  return jwt.sign(
    { id: 'ms-pagamentos', email: 'pagamentos@sistema.interno', role: 'ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  )
}

// ─── Notifica ms-pedidos sobre aprovação do pagamento ─────────────────────────
async function notificarPedido(pedidoId, status) {
  const url = `${process.env.MS_PEDIDOS_URL}/pedidos/${pedidoId}/status`
  try {
    await axios.patch(
      url,
      { status, origem: 'PAGAMENTOS' },
      {
        headers: {
          Authorization: `Bearer ${gerarTokenServico()}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      }
    )
    app.log.info({ pedidoId, status }, 'ms-pedidos notificado com sucesso')
  } catch (err) {
    // Notificação é best-effort: loga mas não falha o pagamento
    app.log.warn(
      { pedidoId, status, erro: err.message },
      'Falha ao notificar ms-pedidos — pagamento registrado mesmo assim'
    )
  }
}

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async () => ({
  status: 'ok',
  servico: 'ms-pagamentos',
  timestamp: new Date().toISOString(),
}))

// ─── POST /api/pagamentos/processar ───────────────────────────────────────────
app.post(
  '/api/pagamentos/processar',
  { preHandler: [app.autenticar] },
  async (request, reply) => {
    const { pedidoId, clienteId, valor, metodo } = request.body

    // Validação básica
    if (!pedidoId || !clienteId || !valor || !metodo) {
      return reply.code(400).send({
        message: 'Campos obrigatórios: pedidoId, clienteId, valor, metodo.',
      })
    }

    const metodosValidos = [
      'PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'DINHEIRO', 'VALE_REFEICAO',
    ]
    if (!metodosValidos.includes(metodo)) {
      return reply.code(400).send({
        message: `Método de pagamento inválido. Use: ${metodosValidos.join(', ')}.`,
      })
    }

    if (typeof valor !== 'number' || valor <= 0 || !Number.isInteger(valor)) {
      return reply.code(400).send({
        message: 'Campo "valor" deve ser um inteiro positivo em centavos.',
      })
    }

    try {
      // 1. Cria o registro de pagamento como PENDENTE
      const pagamento = await prisma.pagamento.create({
        data: {
          pedido_id:  pedidoId,
          cliente_id: clienteId,
          valor,
          metodo,
          status: 'PENDENTE',
        },
      })

      // 2. Simula processamento (substituir por gateway real quando disponível)
      //    Por padrão aprova imediatamente.
      const statusFinal = 'APROVADO'

      // 3. Cria a transação
      await prisma.transacao.create({
        data: {
          pagamento_id:     pagamento.id,
          tipo:             'PAGAMENTO',
          status:           statusFinal,
          gateway_resposta: JSON.stringify({ simulado: true, aprovado: true }),
        },
      })

      // 4. Atualiza o pagamento com o status final
      const pagamentoAtualizado = await prisma.pagamento.update({
        where: { id: pagamento.id },
        data:  { status: statusFinal },
        include: { transacoes: true },
      })

      // 5. Notifica ms-pedidos (best-effort, não bloqueia a resposta)
      if (statusFinal === 'APROVADO') {
        notificarPedido(pedidoId, 'CONFIRMADO')
      }

      return reply.code(201).send({
        success: true,
        data: pagamentoAtualizado,
      })
    } catch (err) {
      app.log.error(err)
      return reply.code(500).send({ message: 'Erro ao processar pagamento.' })
    }
  }
)

// ─── GET /api/pagamentos/:id ───────────────────────────────────────────────────
app.get(
  '/api/pagamentos/:id',
  { preHandler: [app.autenticar] },
  async (request, reply) => {
    const { id } = request.params

    try {
      const pagamento = await prisma.pagamento.findUnique({
        where: { id },
        include: { transacoes: true },
      })

      if (!pagamento) {
        return reply.code(404).send({ message: 'Pagamento não encontrado.' })
      }

      return reply.send({ success: true, data: pagamento })
    } catch (err) {
      app.log.error(err)
      return reply.code(500).send({ message: 'Erro ao buscar pagamento.' })
    }
  }
)

// ─── POST /api/pagamentos/:id/estorno ─────────────────────────────────────────
app.post(
  '/api/pagamentos/:id/estorno',
  { preHandler: [app.autenticar] },
  async (request, reply) => {
    const { id } = request.params

    try {
      const pagamento = await prisma.pagamento.findUnique({
        where: { id },
        include: { transacoes: true },
      })

      if (!pagamento) {
        return reply.code(404).send({ message: 'Pagamento não encontrado.' })
      }

      if (pagamento.status !== 'APROVADO') {
        return reply.code(422).send({
          message: `Apenas pagamentos APROVADOS podem ser estornados. Status atual: ${pagamento.status}.`,
        })
      }

      // Cria transação de estorno
      await prisma.transacao.create({
        data: {
          pagamento_id:     id,
          tipo:             'ESTORNO',
          status:           'APROVADO',
          gateway_resposta: JSON.stringify({ simulado: true, estornado: true }),
        },
      })

      // Atualiza status do pagamento
      const pagamentoEstornado = await prisma.pagamento.update({
        where: { id },
        data:  { status: 'ESTORNADO' },
        include: { transacoes: true },
      })

      // Notifica ms-pedidos para cancelar o pedido
      notificarPedido(pagamento.pedido_id, 'CANCELADO')

      return reply.send({ success: true, data: pagamentoEstornado })
    } catch (err) {
      app.log.error(err)
      return reply.code(500).send({ message: 'Erro ao processar estorno.' })
    }
  }
)

// ─── Inicialização ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3005

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  app.log.info(`✅ ms-pagamentos rodando na porta ${PORT}`)
})
