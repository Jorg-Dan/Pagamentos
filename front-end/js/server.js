const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();

// Permite que o frontend (HTML) envie dados para este backend
app.use(cors());
// Permite que o Node entenda dados no formato JSON
app.use(express.json());

// Configuração da conexão com o seu banco de dados MySQL
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',          // Coloque seu usuário do MySQL
    password: 'sua_senha', // Coloque sua senha do MySQL
    database: 'pagamentos', // O schema do seu script
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Rota para receber e processar o pagamento
app.post('/api/pagamentos', async (req, res) => {
    // Pegando a conexão do pool para garantir que as queries rodem na mesma transação (opcional, mas recomendado)
    const connection = await pool.getConnection();

    try {
        // Dados que o frontend vai enviar
        const { method_type, total_amount } = req.body;
        
        // Em um sistema real, o order_id e customer_id viriam da sessão do usuário ou do carrinho de compras.
        // Aqui estamos gerando valores fictícios para o exemplo funcionar.
        const order_id = Math.floor(Math.random() * 10000); 
        const customer_id = 1; 

        // Inicia a transação no banco de dados
        await connection.beginTransaction();

        // 1. Insere o registro principal na tabela `pagamento`
        const [pagamentoResult] = await connection.execute(
            'INSERT INTO pagamento (order_id, customer_id, total_amount, status) VALUES (?, ?, ?, ?)',
            [order_id, customer_id, total_amount, 'PENDING']
        );
        
        const pagamento_id = pagamentoResult.insertId;

        // 2. Insere os detalhes na tabela `metodo_pagamento`
        // Se for PIX, definimos is_instant como 1 (true), se não, 0 (false)
        const is_instant = (method_type === 'PIX') ? 1 : 0;
        await connection.execute(
            'INSERT INTO metodo_pagamento (pagamento_id, method_type, is_instant) VALUES (?, ?, ?)',
            [pagamento_id, method_type, is_instant]
        );

        // Confirma as inserções no banco
        await connection.commit();

        res.status(201).json({ 
            success: true, 
            message: 'Pagamento registrado com sucesso no banco de dados!', 
            pagamento_id: pagamento_id 
        });

    } catch (error) {
        // Se algo der errado, desfaz tudo que foi feito na transação
        await connection.rollback();
        console.error('Erro ao processar pagamento:', error);
        res.status(500).json({ error: 'Erro interno do servidor ao registrar pagamento.' });
    } finally {
        connection.release();
    }
});

// Inicia o servidor na porta 3000
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});