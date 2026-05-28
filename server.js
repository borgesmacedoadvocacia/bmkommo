const https = require("https");
const http = require("http");
const fs = require("fs");

// Carrega variáveis do arquivo .env
try {
  fs.readFileSync(".env", "utf8").split("\n").forEach(line => {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  });
} catch {}

const TOKEN     = process.env.TOKEN;
const SUBDOMAIN = process.env.SUBDOMAIN || "bmadvocacia";
const PORT      = Number(process.env.PORT) || 3000;

function buildQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

function apiGet(urlPath, params = {}) {
  return new Promise((resolve, reject) => {
    const query = buildQuery(params);
    const fullPath = `/api/v4${urlPath}${query ? "?" + query : ""}`;
    const options = {
      hostname: `${SUBDOMAIN}.kommo.com`,
      path: fullPath,
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode === 204) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error("Resposta inválida")); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let usersCache = null;
async function getUsers() {
  if (usersCache) return usersCache;
  const data = await apiGet("/users", { limit: 250 });
  usersCache = {};
  for (const u of data?._embedded?.users || []) usersCache[u.id] = u.name;
  return usersCache;
}

async function fetchStageLeads(statusId, pipelineId, from, to) {
  const leads = [];
  let page = 1;
  const extra = {
    "filter[is_deleted]": 0,
    "filter[statuses][0][pipeline_id]": pipelineId,
    "filter[statuses][0][status_id]": statusId,
  };
  while (true) {
    let data;
    try { data = await apiGet("/leads", { page, limit: 250, ...extra }); } catch { break; }
    if (!data) break;
    const batch = data?._embedded?.leads || [];
    if (!batch.length) break;
    leads.push(...batch);
    if (batch.length < 250) break;
    page++;
  }
  return leads.filter(l => {
    if (from && l.created_at < from) return false;
    if (to   && l.created_at > to)   return false;
    return true;
  });
}

async function fetchAllLeads(from, to) {
  const leads = [];
  let page = 1;
  const extra = {};
  if (from) extra["filter[created_at][from]"] = from;
  if (to)   extra["filter[created_at][to]"]   = to;
  while (true) {
    let data;
    try { data = await apiGet("/leads", { page, limit: 250, "filter[is_deleted]": 0, ...extra }); } catch { break; }
    if (!data) break;
    const batch = data?._embedded?.leads || [];
    if (!batch.length) break;
    leads.push(...batch);
    if (batch.length < 250) break;
    page++;
  }
  return leads;
}

async function fetchData(from, to) {
  const label = from || to ? `de ${from} até ${to}` : "todos";
  console.log(`[kommo] Buscando dados (${label})...`);
  const [pipelinesRes, leads] = await Promise.all([
    apiGet("/leads/pipelines", { limit: 250 }),
    fetchAllLeads(from, to),
  ]);
  const pipelines = pipelinesRes?._embedded?.pipelines || [];
  console.log(`[kommo] ${pipelines.length} funis, ${leads.length} leads`);

  const stageMap = {};
  const pipelineData = {};

  const PIPELINES_EXCLUIDOS = ["Processual", "Instagram"];

  for (const pipeline of pipelines.filter(p => !PIPELINES_EXCLUIDOS.includes(p.name))) {
    const statuses = [...(pipeline._embedded?.statuses || [])].sort((a, b) => (a.sort || 0) - (b.sort || 0));
    pipelineData[pipeline.id] = {
      name: pipeline.name,
      total_leads: 0,
      stages: Object.fromEntries(statuses.map((s) => {
        stageMap[s.id] = pipeline.id;
        return [s.id, { name: s.name, color: s.color || "#6366f1", type: s.type || 0, sort: s.sort || 0, leads: 0 }];
      })),
    };
  }

  // Mapa pipeline_name -> { id, stages: { stage_name -> stage_id } }
  const pipelineByName = {};
  for (const pipeline of pipelines) {
    const stages = {};
    for (const s of pipeline._embedded?.statuses || []) {
      stages[s.name.trim()] = s.id;
    }
    pipelineByName[pipeline.name.trim()] = { id: pipeline.id, stages };
  }

  function buildIds(rules) {
    const ids = new Set();
    for (const [pName, excluidos] of Object.entries(rules)) {
      const p = pipelineByName[pName];
      if (!p) continue;
      for (const [stageName, stageId] of Object.entries(p.stages)) {
        if (!excluidos.map(e => e.trim().toLowerCase()).includes(stageName.trim().toLowerCase()))
          ids.add(stageId);
      }
    }
    return ids;
  }

  const triagemIds = buildIds({
    "[API] CRM Comercial": ["Entrada de Leads", "NÃO RESPONDEU A TRIAGEM", "Closed - won", "Closed - lost"],
    "[SP] CRM Comercial":  ["Entrada de Leads", "1º Contato", "Respondeu FUP 1º Contato", "Venda ganha", "Venda perdida", "Sem resposta: ELEGIBILIDADE"],
    "[API] Follow Up":     [],
  });

  const elegiveisIds = buildIds({
    "[API] CRM Comercial": ["Entrada de Leads", "Aguardando Forms", "Quer atendimento (Inelegível)", "NÃO RESPONDEU A TRIAGEM", "Inelegível", "Lead Perdido: Outros Motivos", "Sem resposta: ELEGIBILIDADE", "Closed - won", "Closed - lost"],
    "[SP] CRM Comercial":  ["Entrada de Leads", "1º Contato", "Respondeu FUP 1º Contato", "Inelegível", "Lead Perdido: Outros Motivos", "Sem resposta: ELEGIBILIDADE", "Venda ganha", "Venda perdida"],
    "[API] Follow Up":     [],
  });

  const specialCounts = {
    "Responderam a Triagem": 0,
    "Elegíveis": 0,
    "Responderam a Qualificação": 0,
    "Qualificados (Aguardando Documentação)": 0,
  };

  const qualificacaoIds = buildIds({
    "[API] CRM Comercial": ["Entrada de Leads", "Aguardando Forms", "Quer atendimento (Inelegível)", "Elegíveis", "Análise de Qualificação", "Respondeu FUP Qualificação", "NÃO RESPONDEU A TRIAGEM", "Inelegível", "Sem resposta: QUALIFICAÇÃO", "Lead Perdido: Outros Motivos", "Sem resposta: ELEGIBILIDADE", "Closed - won", "Closed - lost"],
    "[SP] CRM Comercial":  ["Entrada de Leads", "1º Contato", "Respondeu FUP 1º Contato", "Análise de Qualificação", "Respondeu FUP Qualificação", "Inelegível", "Lead Perdido: Outros Motivos", "Sem resposta: ELEGIBILIDADE", "Sem resposta: QUALIFICAÇÃO", "Venda ganha", "Venda perdida"],
    "[API] Follow Up":     ["FUP 1 - Qualificação", "FUP 2 - Qualificação", "FUP 3 - Qualificação", "FUP 4 - Qualificação", "FUP 5 - Qualificação", "FUP 6 - Qualificação", "FUP 7 - Qualificação", "FUP 8 - Qualificação", "Closed - won", "Closed - lost"],
  });

  const qualificadosIds = buildIds({
    "[API] CRM Comercial": ["Entrada de Leads", "Aguardando Forms", "Quer atendimento (Inelegível)", "Elegíveis", "Análise de Qualificação", "Respondeu FUP Qualificação", "NÃO RESPONDEU A TRIAGEM", "Inelegível", "Desqualificado", "Sem resposta: QUALIFICAÇÃO", "Lead Perdido: Outros Motivos", "Sem resposta: ELEGIBILIDADE", "Closed - won", "Closed - lost"],
    "[SP] CRM Comercial":  ["Entrada de Leads", "1º Contato", "Respondeu FUP 1º Contato", "Análise de Qualificação", "Respondeu FUP Qualificação", "Inelegível", "Desqualificado", "Lead Perdido: Outros Motivos", "Sem resposta: ELEGIBILIDADE", "Sem resposta: QUALIFICAÇÃO", "Venda ganha", "Venda perdida"],
    "[API] Follow Up":     ["FUP 1 - Qualificação", "FUP 2 - Qualificação", "FUP 3 - Qualificação", "FUP 4 - Qualificação", "FUP 5 - Qualificação", "FUP 6 - Qualificação", "FUP 7 - Qualificação", "FUP 8 - Qualificação", "Closed - won", "Closed - lost"],
  });

  for (const lead of leads) {
    const pid = lead.pipeline_id;
    const sid = lead.status_id;
    if (pipelineData[pid]?.stages[sid] !== undefined) {
      pipelineData[pid].stages[sid].leads++;
      pipelineData[pid].total_leads++;
    }
    if (triagemIds.has(sid))      specialCounts["Responderam a Triagem"]++;
    if (elegiveisIds.has(sid))    specialCounts["Elegíveis"]++;
    if (qualificacaoIds.has(sid)) specialCounts["Responderam a Qualificação"]++;
    if (qualificadosIds.has(sid)) specialCounts["Qualificados (Aguardando Documentação)"]++;
  }

  const specialIds = {
    "Responderam a Triagem": [...triagemIds],
    "Elegíveis": [...elegiveisIds],
    "Responderam a Qualificação": [...qualificacaoIds],
    "Qualificados (Aguardando Documentação)": [...qualificadosIds],
  };

  return { pipelines: pipelineData, totalLeads: leads.length, specialCounts, specialIds };
}

const HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard CRM — BM Advocacia</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #1e293b; min-height: 100vh; }
    header {
      background: linear-gradient(135deg, #1e3a5f 0%, #2d6a9f 100%);
      color: white; padding: 24px 40px;
      display: flex; justify-content: space-between; align-items: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.2);
    }
    header h1 { font-size: 1.6rem; font-weight: 700; }
    header p { font-size: 0.85rem; opacity: 0.75; margin-top: 4px; }
    .header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
    .updated { font-size: 0.8rem; opacity: 0.7; text-align: right; }

    #btn-refresh {
      background: rgba(255,255,255,0.15);
      color: white;
      border: 1.5px solid rgba(255,255,255,0.4);
      border-radius: 8px;
      padding: 8px 18px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      display: flex; align-items: center; gap: 7px;
      transition: background 0.2s;
    }
    #btn-refresh:hover { background: rgba(255,255,255,0.25); }
    #btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
    #btn-refresh svg { transition: transform 0.6s; }
    #btn-refresh.loading svg { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .summary-bar { display: flex; gap: 20px; padding: 24px 40px; flex-wrap: wrap; }
    .summary-card {
      background: white; border-radius: 12px; padding: 20px 28px;
      flex: 1; min-width: 180px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      border-top: 4px solid #2d6a9f;
    }
    .summary-card .label { font-size: 0.8rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-card .value { font-size: 2rem; font-weight: 700; color: #1e293b; margin-top: 6px; }
    .special-card { cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
    .special-card:hover { border-color: #2d6a9f; box-shadow: 0 0 0 3px rgba(45,106,159,0.1); }
    .special-card.active { border-color: #2d6a9f; background: #eff6ff; box-shadow: 0 0 0 3px rgba(45,106,159,0.15); }
    .special-card.active .value { color: #2d6a9f; }

    .pipelines-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 20px; padding: 0 40px 40px;
    }
    .pipeline-card { background: white; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); overflow: hidden; }
    .pipeline-header {
      padding: 18px 22px 14px; border-bottom: 1px solid #f1f5f9;
      display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap;
    }
    .pipeline-header h3 { font-size: 1rem; font-weight: 600; }
    .meta-chip {
      background: #f1f5f9; border-radius: 20px; padding: 3px 10px;
      font-size: 0.78rem; color: #475569; font-weight: 500;
    }
    .stages-list { padding: 14px 22px 18px; display: flex; flex-direction: column; gap: 10px; }
    .stage-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .stage-left { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; max-width: 45%; }
    .stage-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .stage-name { font-size: 0.85rem; color: #374151; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .stage-right { display: flex; align-items: center; gap: 10px; flex: 1; }
    .bar-wrap { flex: 1; background: #f1f5f9; border-radius: 99px; height: 8px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 99px; min-width: 4px; }
    .stage-count { font-size: 0.85rem; font-weight: 600; color: #1e293b; min-width: 24px; text-align: right; }
    .badge { font-size: 0.65rem; padding: 1px 6px; border-radius: 10px; font-weight: 600; }
    .badge-won { background: #dcfce7; color: #15803d; }
    .badge-lost { background: #fee2e2; color: #dc2626; }

    .stage-row { cursor: pointer; border-radius: 6px; padding: 2px 4px; margin: 0 -4px; transition: background 0.12s; }
    .stage-row:hover { background: #f1f5f9; }

    /* Painel lateral */
    #leads-panel {
      position: fixed; top: 0; right: -480px; width: 460px; height: 100vh;
      background: white; box-shadow: -4px 0 24px rgba(0,0,0,0.12);
      display: flex; flex-direction: column;
      transition: right 0.25s ease; z-index: 200;
    }
    #leads-panel.open { right: 0; }
    .panel-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.25);
      z-index: 199; display: none;
    }
    .panel-overlay.open { display: block; }
    .panel-header {
      padding: 18px 20px; border-bottom: 1px solid #e2e8f0;
      display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
    }
    .panel-header h2 { font-size: 1rem; font-weight: 600; color: #1e293b; }
    .panel-header p { font-size: 0.8rem; color: #64748b; margin-top: 3px; }
    .panel-close {
      background: none; border: none; cursor: pointer; color: #94a3b8;
      padding: 2px; border-radius: 4px; flex-shrink: 0;
    }
    .panel-close:hover { color: #1e293b; }
    .panel-body { flex: 1; overflow-y: auto; padding: 12px 0; }
    .panel-loading { padding: 40px; text-align: center; color: #94a3b8; font-size: 0.9rem; }
    .lead-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 20px; gap: 12px; border-bottom: 1px solid #f8fafc;
      transition: background 0.1s;
    }
    .lead-item:hover { background: #f8fafc; }
    .lead-item a {
      font-size: 0.88rem; font-weight: 500; color: #1e293b;
      text-decoration: none; display: block;
    }
    .lead-item a:hover { color: #2d6a9f; text-decoration: underline; }
    .lead-meta { font-size: 0.78rem; color: #64748b; margin-top: 2px; }
    .lead-date { font-size: 0.78rem; color: #94a3b8; white-space: nowrap; flex-shrink: 0; }

    #loading-overlay {
      position: fixed; inset: 0; background: rgba(240,242,245,0.8);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
      font-size: 1rem; color: #475569; z-index: 99;
    }
    #loading-overlay.hidden { display: none; }
    .spinner { width: 40px; height: 40px; border: 4px solid #e2e8f0; border-top-color: #2d6a9f; border-radius: 50%; animation: spin 0.8s linear infinite; }

    .filter-bar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 12px 40px;
      background: white;
      border-bottom: 1px solid #e2e8f0;
    }
    .filter-label { font-size: 0.82rem; font-weight: 600; color: #475569; white-space: nowrap; }

    .period-selector { position: relative; }
    .period-btn {
      display: flex; align-items: center; gap: 7px;
      background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 8px;
      padding: 7px 12px; font-size: 0.83rem; font-weight: 500; color: #1e293b;
      cursor: pointer; white-space: nowrap; transition: border-color 0.15s;
    }
    .period-btn:hover, .period-btn.open { border-color: #2d6a9f; background: white; }

    .period-dropdown {
      position: absolute; top: calc(100% + 6px); left: 0;
      background: #1e293b; border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      min-width: 230px; z-index: 100; padding: 6px 0; overflow: hidden;
    }
    .period-dropdown.hidden { display: none; }
    .period-option {
      padding: 9px 16px; font-size: 0.85rem; color: #cbd5e1;
      cursor: pointer; display: flex; align-items: center; gap: 8px;
      transition: background 0.1s;
    }
    .period-option:hover { background: #334155; color: white; }
    .period-option.active { background: #2d6a9f; color: white; }
    .period-divider { height: 1px; background: #334155; margin: 4px 0; }
    .period-custom-opt { color: #94a3b8; }
    .period-custom-opt:hover { color: white; }

    .custom-dates {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .custom-dates.hidden { display: none; }
    .custom-dates input[type="date"] {
      border: 1.5px solid #e2e8f0; border-radius: 7px;
      padding: 6px 9px; font-size: 0.82rem; color: #1e293b; outline: none; cursor: pointer;
    }
    .custom-dates input[type="date"]:focus { border-color: #2d6a9f; }
    .btn-apply {
      background: #2d6a9f; color: white; border: none;
      border-radius: 7px; padding: 6px 14px;
      font-size: 0.82rem; font-weight: 600; cursor: pointer;
    }
    .btn-apply:hover { background: #1e3a5f; }
    .btn-reset {
      background: #f1f5f9; color: #64748b; border: none;
      border-radius: 7px; padding: 6px 9px; cursor: pointer; display: flex; align-items: center;
    }
    .btn-reset:hover { background: #e2e8f0; color: #1e293b; }

    /* ── Tablet ────────────────────────────────────────────── */
    @media (max-width: 900px) {
      header { padding: 20px 24px; }
      .summary-bar, .pipelines-grid { padding-left: 24px; padding-right: 24px; }
      .filter-bar { padding-left: 24px; padding-right: 24px; }
      .pipelines-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
    }

    /* ── Mobile ────────────────────────────────────────────── */
    @media (max-width: 640px) {
      header {
        padding: 16px;
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
      }
      header h1 { font-size: 1.35rem; }
      .header-right {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
      }
      .updated { text-align: left; }

      .filter-bar {
        padding: 10px 16px;
        gap: 8px;
      }
      .period-btn { font-size: 0.8rem; padding: 6px 10px; }
      .period-dropdown { min-width: 200px; }
      .custom-dates { gap: 6px; }
      .custom-dates input[type="date"] { font-size: 0.78rem; padding: 5px 7px; }

      .summary-bar, .pipelines-grid { padding: 12px 16px; gap: 12px; }
      .summary-bar { padding-bottom: 0; }

      .summary-card {
        flex: 1 1 calc(50% - 6px);
        min-width: 0;
        padding: 14px 16px;
      }
      .summary-card .value { font-size: 1.6rem; }

      .pipelines-grid {
        padding-top: 12px;
        grid-template-columns: 1fr;
      }

      .stages-list { padding: 10px 16px 14px; gap: 8px; }
      .stage-row { min-height: 40px; padding: 4px 6px; margin: 0 -6px; }
      .stage-left { max-width: 50%; }
      .stage-name { font-size: 0.82rem; }
      .bar-wrap { height: 7px; }

      /* Painel lateral: largura total no mobile */
      #leads-panel {
        width: 100%;
        right: -100%;
        border-radius: 16px 16px 0 0;
        top: auto;
        bottom: -100vh;
        height: 85vh;
        right: 0;
        transition: bottom 0.25s ease;
      }
      #leads-panel.open { bottom: 0; right: 0; }
      .lead-item { padding: 10px 16px; }
    }
  </style>
</head>
<body>
  <div id="loading-overlay">
    <div class="spinner"></div>
    <span>Carregando dados do Kommo...</span>
  </div>

  <header>
    <div>
      <h1>Dashboard CRM</h1>
      <p>BM Advocacia — Kommo CRM</p>
    </div>
    <div class="header-right">
      <button id="btn-refresh" onclick="refresh()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        Atualizar
      </button>
      <div class="updated" id="updated-at">—</div>
    </div>
  </header>

  <div class="filter-bar">
    <span class="filter-label">Lead criado:</span>
    <div class="period-selector" id="period-selector">
      <button class="period-btn" id="period-btn" onclick="toggleDropdown()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span id="period-label">Todos os leads</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="period-dropdown hidden" id="period-dropdown">
        <div class="period-option" onclick="selectPeriod('all')">Todos os leads</div>
        <div class="period-option" onclick="selectPeriod('today')">Hoje</div>
        <div class="period-option" onclick="selectPeriod('yesterday')">Ontem</div>
        <div class="period-option" onclick="selectPeriod('week')">Esta semana</div>
        <div class="period-option" onclick="selectPeriod('month')">Este mês, até agora</div>
        <div class="period-option" onclick="selectPeriod('year')">Este ano, até agora</div>
        <div class="period-option" onclick="selectPeriod('last_month')">Mês passado</div>
        <div class="period-option" onclick="selectPeriod('last_year')">Ano passado</div>
        <div class="period-divider"></div>
        <div class="period-option period-custom-opt" onclick="selectPeriod('custom')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          Período fixo (personalizado)
        </div>
      </div>
    </div>
    <div class="custom-dates hidden" id="custom-dates">
      <input type="date" id="filter-from">
      <span style="color:#94a3b8;font-size:0.8rem">→</span>
      <input type="date" id="filter-to">
      <button class="btn-apply" onclick="applyCustom()">Aplicar</button>
    </div>
    <button class="btn-reset" id="btn-reset" onclick="resetFilter()" title="Limpar filtro">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    </button>
  </div>

  <div class="summary-bar" id="summary-bar"></div>
  <div class="summary-bar" id="special-bar"></div>
  <div class="pipelines-grid" id="pipelines-grid"></div>

  <div class="panel-overlay" id="panel-overlay" onclick="closePanel()"></div>
  <div id="leads-panel">
    <div class="panel-header">
      <div>
        <h2 id="panel-title">Leads</h2>
        <p id="panel-subtitle"></p>
      </div>
      <button class="panel-close" onclick="closePanel()">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="panel-body" id="panel-body">
      <div class="panel-loading">Carregando...</div>
    </div>
  </div>

  <script>
    const btn = document.getElementById('btn-refresh');
    const overlay = document.getElementById('loading-overlay');

    function formatDate(d) {
      return d.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    }

    function colorValid(c) {
      if (!c || c === '#') return '#6366f1';
      return c.startsWith('#') ? c : '#' + c;
    }

    let allData = null;
    let activeFilter = null;

    function buildGrid(pipelines, filterIds) {
      const idSet = filterIds ? new Set(filterIds.map(Number)) : null;
      let grid = '';
      for (const [pid, pdata] of Object.entries(pipelines)) {
        let rows = '';
        let filteredTotal = 0;
        const sortedStages = Object.entries(pdata.stages).sort((a, b) => (a[1].sort || 0) - (b[1].sort || 0));
        for (const [sid, stage] of sortedStages) {
          if (stage.leads === 0) continue;
          if (idSet && !idSet.has(Number(sid))) continue;
          filteredTotal += stage.leads;
        }
        if (filteredTotal === 0) continue;
        for (const [sid, stage] of sortedStages) {
          if (stage.leads === 0) continue;
          if (idSet && !idSet.has(Number(sid))) continue;
          const pct = filteredTotal > 0 ? (stage.leads / filteredTotal * 100).toFixed(1) : 0;
          const color = colorValid(stage.color);
          const badge = stage.type === 142
            ? '<span class="badge badge-won">Ganho</span>'
            : stage.type === 143 ? '<span class="badge badge-lost">Perdido</span>' : '';
          rows += \`
            <div class="stage-row" onclick="openPanel(\${sid}, \${pid}, '\${stage.name.replace(/'/g,"\\\\'")}', '\${pdata.name.replace(/'/g,"\\\\'")}', \${filteredTotal})">
              <div class="stage-left">
                <div class="stage-dot" style="background:\${color}"></div>
                <span class="stage-name">\${stage.name} \${badge}</span>
              </div>
              <div class="stage-right">
                <div class="bar-wrap"><div class="bar-fill" style="width:\${pct}%;background:\${color}"></div></div>
                <span class="stage-count">\${stage.leads}</span>
              </div>
            </div>\`;
        }
        grid += \`
          <div class="pipeline-card">
            <div class="pipeline-header">
              <h3>\${pdata.name}</h3>
              <span class="meta-chip">\${filteredTotal} leads</span>
            </div>
            <div class="stages-list">\${rows}</div>
          </div>\`;
      }
      return grid;
    }

    function selectSpecialCard(key) {
      if (activeFilter === key) {
        activeFilter = null;
      } else {
        activeFilter = key;
      }
      document.querySelectorAll('.special-card').forEach(el => {
        el.classList.toggle('active', el.dataset.key === activeFilter);
      });
      const filterIds = activeFilter ? (allData.specialIds[activeFilter] || []) : null;
      document.getElementById('pipelines-grid').innerHTML = buildGrid(allData.pipelines, filterIds);
    }

    function render(data) {
      allData = data;
      activeFilter = null;
      const { pipelines, totalLeads, specialCounts } = data;
      const activePipelines = Object.values(pipelines).filter(p => p.total_leads > 0).length;

      document.getElementById('summary-bar').innerHTML = \`
        <div class="summary-card"><div class="label">Total de Leads</div><div class="value">\${totalLeads}</div></div>
        <div class="summary-card"><div class="label">Funis Ativos</div><div class="value">\${activePipelines}</div></div>
      \`;

      const sc = specialCounts || {};
      const specials = [
        'Responderam a Triagem',
        'Elegíveis',
        'Responderam a Qualificação',
        'Qualificados (Aguardando Documentação)',
      ];
      document.getElementById('special-bar').innerHTML = specials.map(key => \`
        <div class="summary-card special-card" data-key="\${key}" onclick="selectSpecialCard('\${key}')">
          <div class="label">\${key}</div>
          <div class="value">\${sc[key] ?? '—'}</div>
        </div>
      \`).join('');

      document.getElementById('pipelines-grid').innerHTML = buildGrid(pipelines, null);
      document.getElementById('updated-at').innerHTML = 'Atualizado em<br><strong>' + formatDate(new Date()) + '</strong>';
    }

    const PERIODS = {
      all:        { label: 'Todos os leads',          from: null,          to: null },
      today:      { label: 'Hoje' },
      yesterday:  { label: 'Ontem' },
      week:       { label: 'Esta semana' },
      month:      { label: 'Este mês, até agora' },
      year:       { label: 'Este ano, até agora' },
      last_month: { label: 'Mês passado' },
      last_year:  { label: 'Ano passado' },
      custom:     { label: 'Período personalizado' },
    };

    function fmt(d) { return d.toISOString().slice(0, 10); }

    function getDates(key) {
      const now = new Date();
      const today = fmt(now);
      if (key === 'all')        return { from: null, to: null };
      if (key === 'today')      return { from: today, to: today };
      if (key === 'yesterday')  { const d = new Date(now); d.setDate(d.getDate()-1); const s=fmt(d); return { from:s, to:s }; }
      if (key === 'week')       { const d = new Date(now); d.setDate(d.getDate() - ((d.getDay()+6)%7)); return { from: fmt(d), to: today }; }
      if (key === 'month')      return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
      if (key === 'year')       return { from: fmt(new Date(now.getFullYear(), 0, 1)), to: today };
      if (key === 'last_month') { const f=new Date(now.getFullYear(),now.getMonth()-1,1); const t=new Date(now.getFullYear(),now.getMonth(),0); return { from:fmt(f), to:fmt(t) }; }
      if (key === 'last_year')  return { from: \`\${now.getFullYear()-1}-01-01\`, to: \`\${now.getFullYear()-1}-12-31\` };
      return { from: null, to: null };
    }

    let currentPeriod = 'all';

    function toggleDropdown() {
      const dd = document.getElementById('period-dropdown');
      const pb = document.getElementById('period-btn');
      dd.classList.toggle('hidden');
      pb.classList.toggle('open', !dd.classList.contains('hidden'));
    }

    function selectPeriod(key) {
      currentPeriod = key;
      document.getElementById('period-dropdown').classList.add('hidden');
      document.getElementById('period-btn').classList.remove('open');
      document.getElementById('period-label').textContent = PERIODS[key].label;

      // highlight active
      document.querySelectorAll('.period-option').forEach(el => el.classList.remove('active'));
      event.currentTarget.classList.add('active');

      const customDates = document.getElementById('custom-dates');
      if (key === 'custom') {
        customDates.classList.remove('hidden');
        return;
      }
      customDates.classList.add('hidden');
      const { from, to } = getDates(key);
      refresh(from, to);
    }

    function applyCustom() {
      const from = document.getElementById('filter-from').value;
      const to   = document.getElementById('filter-to').value;
      if (!from && !to) return;
      refresh(from || null, to || null);
    }

    function resetFilter() {
      currentPeriod = 'all';
      document.getElementById('period-label').textContent = 'Todos os leads';
      document.getElementById('custom-dates').classList.add('hidden');
      document.getElementById('filter-from').value = '';
      document.getElementById('filter-to').value = '';
      document.querySelectorAll('.period-option').forEach(el => el.classList.remove('active'));
      refresh(null, null);
    }

    // Fecha dropdown ao clicar fora
    document.addEventListener('click', (e) => {
      if (!document.getElementById('period-selector').contains(e.target)) {
        document.getElementById('period-dropdown').classList.add('hidden');
        document.getElementById('period-btn').classList.remove('open');
      }
    });

    async function refresh(from, to) {
      currentFrom = from || null;
      currentTo   = to   || null;
      closePanel();
      btn.disabled = true;
      btn.classList.add('loading');
      try {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to)   params.set('to', to);
        const url = '/api/data' + (params.toString() ? '?' + params : '');
        const res = await fetch(url);
        if (!res.ok) throw new Error('Erro ' + res.status);
        const data = await res.json();
        render(data);
      } catch (e) {
        alert('Erro ao atualizar: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    }

    let currentFrom = null, currentTo = null;

    function closePanel() {
      document.getElementById('leads-panel').classList.remove('open');
      document.getElementById('panel-overlay').classList.remove('open');
    }

    async function openPanel(sid, pid, stageName, pipelineName, total) {
      document.getElementById('panel-title').textContent = stageName;
      document.getElementById('panel-subtitle').textContent = pipelineName + ' · ' + total + ' lead' + (total !== 1 ? 's' : '');
      document.getElementById('panel-body').innerHTML = '<div class="panel-loading">Carregando leads...</div>';
      document.getElementById('leads-panel').classList.add('open');
      document.getElementById('panel-overlay').classList.add('open');

      try {
        const params = new URLSearchParams({ status_id: sid, pipeline_id: pid });
        if (currentFrom) params.set('from', currentFrom);
        if (currentTo)   params.set('to', currentTo);
        const res = await fetch('/api/stage-leads?' + params);
        const leads = await res.json();

        if (!leads.length) {
          document.getElementById('panel-body').innerHTML = '<div class="panel-loading">Nenhum lead encontrado.</div>';
          return;
        }

        const fmtDate = ts => new Date(ts * 1000).toLocaleDateString('pt-BR');
        document.getElementById('panel-body').innerHTML = leads.map(l => \`
          <div class="lead-item">
            <div>
              <a href="https://${SUBDOMAIN}.kommo.com/leads/detail/\${l.id}" target="_blank">\${l.name}</a>
              <div class="lead-meta">\${l.responsible}</div>
            </div>
            <div class="lead-date">\${fmtDate(l.created_at)}</div>
          </div>
        \`).join('');
      } catch (e) {
        document.getElementById('panel-body').innerHTML = '<div class="panel-loading">Erro ao carregar leads.</div>';
      }
    }

    (async () => {
      await refresh(null, null);
      overlay.classList.add('hidden');
    })();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  } else if (req.url.startsWith("/api/data")) {
    try {
      const qs = new URL(req.url, "http://localhost").searchParams;
      const from = qs.get("from") ? Math.floor(new Date(qs.get("from") + "T00:00:00").getTime() / 1000) : null;
      const to   = qs.get("to")   ? Math.floor(new Date(qs.get("to") + "T23:59:59").getTime() / 1000) : null;
      const data = await fetchData(from, to);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error("[erro]", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (req.url.startsWith("/api/stage-leads")) {
    try {
      const qs = new URL(req.url, "http://localhost").searchParams;
      const statusId   = qs.get("status_id");
      const pipelineId = qs.get("pipeline_id");
      const from = qs.get("from") ? Math.floor(new Date(qs.get("from") + "T00:00:00").getTime() / 1000) : null;
      const to   = qs.get("to")   ? Math.floor(new Date(qs.get("to") + "T23:59:59").getTime() / 1000) : null;
      const [leads, users] = await Promise.all([
        fetchStageLeads(statusId, pipelineId, from, to),
        getUsers(),
      ]);
      const result = leads.map(l => ({
        id: l.id,
        name: l.name || "(sem nome)",
        responsible: users[l.responsible_user_id] || "—",
        created_at: l.created_at,
        price: l.price || 0,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error("[erro stage-leads]", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`\n✓ Dashboard rodando em http://localhost:${PORT}`);
  console.log("  Pressione Ctrl+C para encerrar.\n");
});
