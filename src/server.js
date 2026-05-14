require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// Rota para CRIAR PAGAMENTO (Salva nas tabelas 'pagamento' e 'metodo_pagamento')
app.post('/pagamentos', async (req, res) => {
    const { order_id, customer_id, total_amount, method_type } = req.body;

    try {
        const novo = await prisma.pagamento.create({
            data: {
                order_id: parseInt(order_id),
                customer_id: parseInt(customer_id),
                total_amount: parseFloat(total_amount),
                metodos: {
                    create: {
                        method_type: method_type,
                        is_instant: method_type === 'PIX' ? 1 : 0
                    }
                }
            },
            include: { metodos: true }
        });
        res.status(201).json(novo);
    } catch (err) {
        res.status(500).json({ error: "Erro ao criar pagamento", details: err.message });
    }
});

// Rota para consultar um pagamento específico
app.get('/pagamentos/:id', async (req, res) => {
    const { id } = req.params;
    const pag = await prisma.pagamento.findUnique({
        where: { id: parseInt(id) },
        include: { metodos: true, cartoes: true, transacoes: true }
    });
    res.json(pag || { message: "Não encontrado" });
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => console.log(` PAGAMENTOS FUNCIONANDO${PORT}`));