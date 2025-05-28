const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const SIMPLIFIQUE_BASE_URL = 'https://app.simplifique.ai/pt/chatbot/api/v1';
const PORT = process.env.PORT || 3000;

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  next();
});

// JSON parsing
app.use(express.json());

app.post('/v1/chat/completions', async (req, res) => {
  console.log('\n=== Nova requisição recebida ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));

  let openaiRequest = req.body;
  let chatbotUuid = '';
  let apiToken = '';
  let userQuery = '';
  let userKey = '';
  let customSystemPrompt = '';
  let lastMessage = null;
  let simplifiqueData = undefined;
  let promptTokens = 0, completionTokens = 0, totalTokens = 0;

  try {
    // Auth header parsing
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Authorization header missing or invalid');
    }
    const authData = authHeader.replace('Bearer ', '').trim();
    [apiToken, chatbotUuid] = authData.split(':');
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(chatbotUuid)) {
      throw new Error('Invalid chatbot UUID format');
    }

    // Parsing messages
    let messages = openaiRequest.messages || [];
    // Suporte a formato string (n8n) e OpenAI
    if (messages.length === 1 && typeof messages[0] === 'string') {
      const messageString = messages[0];
      // System prompt via string
      const systemMatch = messageString.match(/System:\s*([\s\S]*?)(?=Contexto Extra|$)/);
      if (systemMatch) {
        customSystemPrompt = systemMatch[1].trim();
      }
      const contextoMatch = messageString.match(/Contexto Extra\s*Human:\s*([\s\S]*?)$/);
      if (contextoMatch) {
        const contextoContent = contextoMatch[1].trim();
        // Query entre Query: e user_key:
        const queryMatch = contextoContent.match(/Query:\s*([\s\S]*?)\s*user_key:/i);
        if (queryMatch) userQuery = queryMatch[1].trim();
        // user_key
        const userKeyMatch = contextoContent.match(/user_key:\s*([^\n\r]*)/i);
        if (userKeyMatch) userKey = userKeyMatch[1].trim();
      }
      if (!userQuery) {
        const humanMatch = messageString.match(/Human:\s*([^\n\r]*)/);
        if (humanMatch) userQuery = humanMatch[1].trim();
      }
      if (userQuery) lastMessage = { role: 'user', content: userQuery };
    } else if (Array.isArray(messages)) {
      // Formato OpenAI nativo
      // System prompt (apenas para custom prompt)
      const systemMessage = messages.find(
        m => typeof m === 'object' && m.role === 'system' && m.content
      );
      if (systemMessage) customSystemPrompt = systemMessage.content.trim();
      // Pega a última mensagem do usuário
      const validMessages = messages.filter(m => typeof m === 'object' && m.content);
      lastMessage = validMessages.length > 0 ? validMessages[validMessages.length - 1] : null;
      if (lastMessage && lastMessage.content) userQuery = lastMessage.content.trim();
    }

    // Garante que a query do usuário exista
    if (!userQuery) {
      throw new Error('No user message found');
    }

    // Captura user_key do model, headers, fallback, etc
    const KNOWN_MODELS = ['gpt-3.5-turbo', 'gpt-4', 'gpt-4o', 'simplifique-default'];
    if (!userKey) {
      if (openaiRequest.model && !KNOWN_MODELS.includes(openaiRequest.model)) {
        userKey = openaiRequest.model;
      } else {
        userKey = openaiRequest.user ||
                  req.headers['x-user-key'] ||
                  req.headers['x-user-id'] ||
                  `n8n-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }
    }

    // Prepara payload Simplifique.ai
    const simplifiqueRequest = {
      chatbot_uuid: chatbotUuid,
      query: userQuery,
      user_key: userKey
    };
    if (customSystemPrompt && customSystemPrompt.trim()) {
      simplifiqueRequest.custom_base_system_prompt = customSystemPrompt;
    }

    console.log('\n=== Enviando para Simplifique.ai ===');
    console.log('Payload:', JSON.stringify(simplifiqueRequest, null, 2));

    // Chama Simplifique
    try {
      const simplifiqueResponse = await axios.post(
        `${SIMPLIFIQUE_BASE_URL}/message/`,
        simplifiqueRequest,
        {
          headers: {
            'Authorization': `Token ${apiToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000
        }
      );
      simplifiqueData = simplifiqueResponse.data;
    } catch (err) {
      // Se erro no simplifique, retorna erro "humano" para n8n
      simplifiqueData = {
        data: {
          answer: 'Desculpe, não foi possível obter uma resposta do chatbot agora.',
          chat_id: null
        }
      };
      console.error('\n=== Erro ao chamar Simplifique.ai ===');
      console.error(err.response?.data || err.message);
    }

    // Garante tokens estimados (safe fallback)
    promptTokens = lastMessage?.content
      ? Math.ceil(lastMessage.content.length / 4)
      : Math.ceil(userQuery.length / 4);
    completionTokens = simplifiqueData?.data?.answer
      ? Math.ceil(String(simplifiqueData.data.answer).length / 4)
      : 0;
    totalTokens = promptTokens + completionTokens;

    // Resposta no formato OpenAI (garante existence do message.content)
    const openaiResponse = {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: openaiRequest?.model || 'gpt-3.5-turbo',
      system_fingerprint: `simplifique_${chatbotUuid}`,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: (simplifiqueData && simplifiqueData.data && simplifiqueData.data.answer)
            ? String(simplifiqueData.data.answer)
            : 'Desculpe, não consegui obter uma resposta no momento.'
        },
        logprobs: null,
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: promptTokens || 0,
        completion_tokens: completionTokens || 0,
        total_tokens: totalTokens || 0
      },
      metadata: {
        simplifique_chat_id: (simplifiqueData && simplifiqueData.data && simplifiqueData.data.chat_id) || null,
        service: 'simplifique.ai'
      }
    };

    console.log('\n=== Resposta enviada para n8n ===');
    console.log(JSON.stringify(openaiResponse, null, 2));

    res.json(openaiResponse);

  } catch (error) {
    // Resposta de erro sempre no formato OpenAI, para nunca quebrar n8n/langchain
    console.error('\n=== ERRO GERAL (catch externo) ===');
    console.error(error);

    res.status(500).json({
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: openaiRequest?.model || 'gpt-3.5-turbo',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: `Desculpe, ocorreu um erro: ${error.message || 'erro inesperado.'}`
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      },
      metadata: {
        simplifique_chat_id: null,
        service: 'simplifique.ai'
      }
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Simplifique.ai OpenAI Proxy',
    timestamp: new Date().toISOString(),
    environment: {
      node_env: process.env.NODE_ENV || 'not set',
      port: PORT,
      simplifique_url: SIMPLIFIQUE_BASE_URL
    }
  });
});

app.get('/debug/test', (req, res) => {
  res.json({
    message: 'Debug endpoint working',
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
});

app.get('/v1/models', (req, res) => {
  res.json({
    data: [
      {
        id: 'simplifique-default',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'simplifique.ai'
      }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Simplifique.ai OpenAI Proxy rodando na porta ${PORT}`);
  console.log(`Health check disponível em: http://localhost:${PORT}/health`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, encerrando servidor...');
  process.exit(0);
});


