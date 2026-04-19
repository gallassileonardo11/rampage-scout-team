const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
};

if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
  });
}

const db = process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY ? admin.firestore() : null;
const SHARED_DOC_ID = 'public';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PROVIDER = GROQ_API_KEY ? 'groq' : 'anthropic';
const API_KEY = GROQ_API_KEY || ANTHROPIC_API_KEY;

// Firebase helper functions
async function saveUserData(userId, data) {
  if (!db) return false;
  if (!userId) return false;
  try {
    await db.collection('users').doc(userId).collection('shared').doc('data').set({
      data: data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (error) {
    console.error('Firebase save error:', error);
    return false;
  }
}

async function loadUserData(userId) {
  if (!db) return null;
  if (!userId) return null;
  try {
    const doc = await db.collection('users').doc(userId).collection('shared').doc('data').get();
    if (doc.exists) {
      return doc.data().data;
    }
    return null;
  } catch (error) {
    console.error('Firebase load error:', error);
    return null;
  }
}

// API Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'scout-app (3).html'));
});

app.post('/api/save', async (req, res) => {
  try {
    const { userId = SHARED_DOC_ID, data } = req.body;
    if (!data) {
      return res.status(400).json({ error: 'data é obrigatório' });
    }

    const success = await saveUserData(userId, data);
    if (success) {
      res.json({ success: true });
    } else {
      // Firebase Admin não configurado — retorna 200 (client-side Firebase ou localStorage farão o trabalho)
      res.json({ success: false, message: 'Firebase Admin não configurado no servidor. Use a config Firebase no app.' });
    }
  } catch (error) {
    console.error('Save error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/load/:userId?', async (req, res) => {
  try {
    const userId = req.params.userId || SHARED_DOC_ID;
    const data = await loadUserData(userId);

    if (data) {
      res.json({ data });
    } else {
      res.json({ data: { teams: {} } });
    }
  } catch (error) {
    console.error('Load error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { teamName, gameName, playCount, summary, analysisType, customQuestion, outputMode } = req.body;

    if (!API_KEY) {
      return res.status(500).json({ error: 'API key não configurada' });
    }

    const analysisLabels = {
      terceiro_down: '3º Down',
      posicao_final: 'Posição Final da Bola',
      tendencias_ataque: 'Tendências de Ataque',
      red_zone: 'Red Zone',
      tendencias_defesa: 'Tendências de Defesa',
      custom: 'Consulta Livre'
    };
    const focusLabel = analysisLabels[analysisType] || 'Tendências de Ataque';

    const focusInstructions = {
      terceiro_down: `Foque exclusivamente nas jogadas de 3º Down. Analise: % de conversão no 3º down, distribuição passe/corrida (%), rotas/conceitos mais usados e % de sucesso de cada um, formações ofensivas preferidas e quais coberturas defensivas foram encontradas nessa situação.`,
      posicao_final: `Foque na posição final da bola após cada jogada. Analise: distribuição % por zona (Curto/Médio/Longo × Direita/Centro/Esquerda), quais zonas concentram mais jogadas, tipo de jogada (passe/corrida) preferido por zona (%), taxa de sucesso por zona (%), e onde o ataque é mais eficiente.`,
      tendencias_ataque: `Analise os padrões ofensivos gerais. Foque em: % passe vs corrida no total e por down, formações ofensivas mais usadas (%), conceitos/rotas mais frequentes (%) e taxa de sucesso de cada um (%), down com maior % de conversão, e sequências de jogadas recorrentes.`,
      red_zone: `Foque exclusivamente nas jogadas nas zonas Curto (Direita/Centro/Esquerda). Analise: % de TDs e conversões na Red Zone, tipo de jogada preferido (%), rotas/conceitos mais usados dentro da Red Zone (%), formações ofensivas usadas (%), e % de falhas (incompletos, perdas).`,
      tendencias_defesa: `Analise os padrões defensivos do adversário. Foque em: coberturas mais usadas (% Cover 0/1/2/3/4), formações defensivas mais usadas (% 2DL/3DL/4DL/Blitz), cobertura preferida por down (%), qual cobertura o adversário usa contra passe vs corrida (%), e situações em que o Blitz aparece mais.`
    };

    const focusInstruction = analysisType === 'custom'
      ? `Responda à seguinte pergunta/solicitação do analista, baseando-se exclusivamente nos dados do scout fornecido: "${customQuestion}". Use números e percentuais concretos extraídos dos dados. Se a pergunta não puder ser respondida com os dados disponíveis, explique o que falta.`
      : (focusInstructions[analysisType] || focusInstructions['tendencias_ataque']);

    let systemMessage, prompt;

    if (outputMode === 'charts') {
      systemMessage = 'Você é um analista de futebol americano flag x9 brasileiro. Retorne APENAS um JSON válido, sem markdown, sem código, sem explicação. O JSON deve seguir exatamente a estrutura especificada. Todos os textos devem estar em português do Brasil.';
      const jsonStructure = `{
  "kpis": [{ "nome": "Nome do KPI", "valor": "67%" }],
  "graficos": [{ "titulo": "Título", "tipo": "barra", "dados": [{ "nome": "Categoria", "valor": 67 }] }],
  "insights": ["Recomendação tática objetiva"]
}`;
      prompt = `Analise o scout do time "${teamName}" — jogo "${gameName}" (${playCount} jogadas).

FOCO: ${focusLabel}
${focusInstruction}

Retorne EXCLUSIVAMENTE um JSON válido com esta estrutura:
${jsonStructure}

REGRAS:
- "kpis": 3 a 5 indicadores-chave com valores numéricos/percentuais extraídos dos dados
- "graficos": 2 a 4 gráficos. Cada gráfico tem "titulo", "tipo" ("barra" ou "pizza"), e "dados" (array de objetos com "nome" e "valor" numérico)
- "insights": 2 a 3 recomendações táticas curtas e objetivas baseadas nos dados
- Todos os valores devem ser números concretos extraídos do scout
- NÃO inclua texto fora do JSON, NÃO use markdown, NÃO adicione comentários
${customQuestion ? `- Pergunta específica do analista: "${customQuestion}"` : ''}

SCOUT:
${summary}`;
    } else {
      systemMessage = `Você é um analista de futebol americano flag x9 brasileiro. REGRA ABSOLUTA E INVIOLÁVEL: escreva TODA a resposta EXCLUSIVAMENTE em português do Brasil. NUNCA use inglês em nenhuma palavra, frase ou expressão. NÃO exiba raciocínio interno, pensamento em cadeia ou processo de elaboração — responda APENAS com a análise final pronta. Seja direto, objetivo e baseie-se em porcentagens e números concretos extraídos dos dados fornecidos.`;
      prompt = `[IDIOMA OBRIGATÓRIO: PORTUGUÊS DO BRASIL. NENHUMA PALAVRA EM INGLÊS.]

Analise o scout do time "${teamName}" — jogo "${gameName}" (${playCount} jogadas).

FOCO: ${focusLabel}
${focusInstruction}

FORMATO OBRIGATÓRIO:
- Comece DIRETAMENTE com o primeiro bloco de dados, sem introdução
- Cada bloco: título em CAIXA ALTA + dados em porcentagem (ex: "67% passes, 33% corridas")
- Toda afirmação deve ter número ou % — zero texto genérico
- Ao final, bloco "RECOMENDAÇÃO TÁTICA" com 2-3 ajustes práticos e objetivos
- Máximo 500 palavras
- Apenas texto simples — sem asteriscos, sem markdown, use ━ como separador

SCOUT:
${summary}`;
    }

    let response;
    let data;
    let text;

    if (PROVIDER === 'groq') {
      response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: systemMessage },
            { role: 'user', content: prompt }
          ],
          max_tokens: outputMode === 'charts' ? 2000 : 1200,
          temperature: 0.3
        })
      });

      data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({ error: data.error?.message || data.error || 'Erro na API Groq' });
      }

      text = data.choices?.[0]?.message?.content || 'Erro ao processar.';
      // Remove thinking/reasoning blocks output by some models
      text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      text = text.replace(/^\s*thinking:.*$/gim, '').trim();
    } else {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8000,
          system: systemMessage,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({ error: data.error?.message || 'Erro na API' });
      }

      text = data.content?.map(b => b.text || '').join('') || 'Erro ao processar.';
      text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    }

    res.json({ analysis: text });
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

// ── EMAIL (nodemailer) ──
function createMailTransport() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

app.post('/api/notify-admin', async (req, res) => {
  const { userEmail, userName } = req.body;
  if (!userEmail) return res.status(400).json({ error: 'userEmail obrigatório' });
  const transport = createMailTransport();
  if (!transport) {
    return res.json({ sent: false, reason: 'SMTP não configurado' });
  }
  try {
    await transport.sendMail({
      from: `"P.A.N.D.A. Sistema" <${process.env.SMTP_USER}>`,
      to: process.env.ADMIN_EMAIL || process.env.SMTP_USER,
      subject: '🏈 Novo cadastro pendente — P.A.N.D.A.',
      html: `
        <div style="font-family:monospace;background:#0a0a0a;color:#e8e8e8;padding:32px;max-width:480px">
          <h2 style="color:#c8f135;letter-spacing:4px;font-size:20px;margin-bottom:8px">P.A.N.D.A.</h2>
          <p style="color:#555;font-size:12px;margin-bottom:24px">// Programa de Análise e Neutralização de Decisões Adversárias</p>
          <p style="font-size:14px">Novo usuário aguardando aprovação:</p>
          <div style="border:1px solid #1e1e1e;padding:16px;margin:16px 0;background:#111">
            <p style="margin:0;color:#c8f135">${userEmail}</p>
            ${userName ? `<p style="margin:4px 0 0;color:#555;font-size:12px">${userName}</p>` : ''}
          </div>
          <p style="color:#555;font-size:11px">Acesse o Painel Admin no app para aprovar ou rejeitar.</p>
        </div>`
    });
    console.log(`[PANDA] notify-admin: email enviado para ${process.env.ADMIN_EMAIL} sobre novo usuário: ${userEmail}`);
    res.json({ sent: true });
  } catch(e) {
    console.error('[PANDA] notify-admin ERRO:', e.message);
    res.json({ sent: false, reason: e.message });
  }
});

app.post('/api/confirm-registration', async (req, res) => {
  const { userEmail, userName } = req.body;
  if (!userEmail) return res.status(400).json({ error: 'userEmail obrigatório' });
  const transport = createMailTransport();
  if (!transport) return res.json({ sent: false, reason: 'SMTP não configurado' });
  try {
    await transport.sendMail({
      from: `"P.A.N.D.A." <${process.env.SMTP_USER}>`,
      to: userEmail,
      subject: '✅ Cadastro recebido — P.A.N.D.A.',
      html: `
        <div style="font-family:monospace;background:#0a0a0a;color:#e8e8e8;padding:32px;max-width:480px">
          <h2 style="color:#c8f135;letter-spacing:4px;font-size:20px;margin-bottom:8px">P.A.N.D.A.</h2>
          <p style="color:#555;font-size:12px;margin-bottom:24px">// Programa de Análise e Neutralização de Decisões Adversárias</p>
          ${userName ? `<p style="font-size:14px">Olá, <b style="color:#c8f135">${userName}</b>!</p>` : '<p style="font-size:14px">Olá!</p>'}
          <p style="font-size:13px;margin-top:16px;line-height:1.8">Seu cadastro foi recebido com sucesso.<br>
          Aguarde a aprovação do administrador para acessar o sistema.</p>
          <div style="border:1px solid #1e1e1e;padding:16px;margin:20px 0;background:#111">
            <p style="margin:0;color:#555;font-size:11px;letter-spacing:1px">EMAIL</p>
            <p style="margin:4px 0 0;color:#c8f135">${userEmail}</p>
          </div>
          <p style="color:#555;font-size:11px">Você receberá um contato assim que seu acesso for liberado.</p>
        </div>`
    });
    res.json({ sent: true });
  } catch(e) {
    console.error('Confirm registration email error:', e.message);
    res.json({ sent: false, reason: e.message });
  }
});

app.post('/api/report-bug', async (req, res) => {
  const { userEmail, description } = req.body;
  if (!description) return res.status(400).json({ error: 'description obrigatório' });
  const transport = createMailTransport();
  if (!transport) return res.json({ sent: false, reason: 'SMTP não configurado' });
  try {
    const safeDesc = String(description).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    await transport.sendMail({
      from: `"P.A.N.D.A. Sistema" <${process.env.SMTP_USER}>`,
      to: process.env.ADMIN_EMAIL || process.env.SMTP_USER,
      subject: '🐛 Reporte de Bug — P.A.N.D.A.',
      html: `
        <div style="font-family:monospace;background:#0a0a0a;color:#e8e8e8;padding:32px;max-width:540px">
          <h2 style="color:#c8f135;letter-spacing:4px;font-size:20px;margin-bottom:8px">P.A.N.D.A.</h2>
          <p style="color:#555;font-size:12px;margin-bottom:24px">// Reporte de Bug</p>
          <p style="font-size:14px">Reportado por:</p>
          <div style="border:1px solid #1e1e1e;padding:12px 16px;margin:10px 0 20px;background:#111">
            <p style="margin:0;color:#c8f135">${String(userEmail).replace(/</g,'&lt;')}</p>
          </div>
          <p style="font-size:14px">Descrição:</p>
          <div style="border:1px solid #333;padding:16px;margin:10px 0;background:#111;white-space:pre-wrap;line-height:1.7;color:#ccc">${safeDesc}</div>
        </div>`
    });
    res.json({ sent: true });
  } catch(e) {
    console.error('Bug report email error:', e.message);
    res.json({ sent: false, reason: e.message });
  }
});

app.post('/api/notify-approved', async (req, res) => {
  const { userEmail, userName } = req.body;
  if (!userEmail) return res.status(400).json({ error: 'userEmail obrigatório' });
  const transport = createMailTransport();
  if (!transport) return res.json({ sent: false, reason: 'SMTP não configurado' });
  try {
    await transport.sendMail({
      from: `"P.A.N.D.A." <${process.env.SMTP_USER}>`,
      to: userEmail,
      subject: '🏈 Acesso liberado — P.A.N.D.A.',
      html: `
        <div style="font-family:monospace;background:#0a0a0a;color:#e8e8e8;padding:32px;max-width:480px">
          <h2 style="color:#c8f135;letter-spacing:4px;font-size:20px;margin-bottom:8px">P.A.N.D.A.</h2>
          <p style="color:#555;font-size:12px;margin-bottom:24px">// Programa de Análise e Neutralização de Decisões Adversárias</p>
          ${userName ? `<p style="font-size:14px">Olá, <b style="color:#c8f135">${userName}</b>!</p>` : '<p style="font-size:14px">Olá!</p>'}
          <p style="font-size:13px;margin-top:16px;line-height:1.8">Sua conta foi <b style="color:#c8f135">aprovada</b>. Você já pode acessar o sistema.</p>
          <div style="border:1px solid #1e1e1e;padding:16px;margin:20px 0;background:#111">
            <p style="margin:0;color:#555;font-size:11px;letter-spacing:1px">EMAIL</p>
            <p style="margin:4px 0 0;color:#c8f135">${userEmail}</p>
          </div>
          <p style="color:#555;font-size:11px">Acesse o sistema e comece a usar o P.A.N.D.A.</p>
        </div>`
    });
    res.json({ sent: true });
  } catch(e) {
    console.error('Notify approved email error:', e.message);
    res.json({ sent: false, reason: e.message });
  }
});

// ── Firebase Client Config (compartilhada entre dispositivos) ──
const fs = require('fs');
const FIREBASE_CONFIG_PATH = path.join(__dirname, '.firebase-client-config.json');

app.get('/api/firebase-config', (req, res) => {
  try {
    if (fs.existsSync(FIREBASE_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(FIREBASE_CONFIG_PATH, 'utf8'));
      return res.json({ config });
    }
    res.json({ config: null });
  } catch(e) {
    res.json({ config: null });
  }
});

app.post('/api/firebase-config', (req, res) => {
  try {
    const { config } = req.body;
    if (!config || !config.projectId) {
      return res.status(400).json({ error: 'Config inválida' });
    }
    fs.writeFileSync(FIREBASE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Local dev
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

// Vercel Serverless
module.exports = app;
