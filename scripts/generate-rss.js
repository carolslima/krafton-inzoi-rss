// =============================================================================
// KRAFTON / inZOI RSS Generator
// =============================================================================
// Consome a API da KRAFTON (api-foc.krafton.com), detecta novas notícias e
// gera feed RSS 2.0 compatível com todos os leitores do mercado.
//
// API real — formato HAL+JSON (Spring HATEOAS):
//   _embedded.post[]  → array de notícias
//   _links.next.href  → paginação
//   page.totalPages   → total de páginas
//
// Campos reais por post:
//   postId, title, category, identifier, createdAt, displayStartTime,
//   images[].imageUrl, images[].thumbUrl, totalViewCnt, totalLikeCnt
//
// Execução:
//   node scripts/generate-rss.js
//
// Requisitos:
//   Node.js >= 22 (fetch nativo, fs/promises, ESM)
//   Nenhuma dependência externa
// =============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constantes configuráveis — ajuste conforme necessário
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

/**
 * URL base da API da KRAFTON.
 *
 * Endpoint verificado em 2026-06-29:
 *   - Content-Type: application/hal+json (Spring HATEOAS)
 *   - Requer header Origin: https://playinzoi.com (CORS CloudFront)
 *   - Paginação: page={n}&size={n} (máximo testado: 20)
 */
const API_BASE = "https://api-foc.krafton.com/content/post/news";
const API_PARAMS = "lang=pt-br&searchType=TITLE_AND_CONTENT";
const API_PAGE_SIZE = 20; // Posts por página

/**
 * Headers obrigatórios para a API.
 *
 * A API utiliza um API Gateway que roteia requisições com base em headers
 * customizados. Os 3 headers abaixo são OBRIGATÓRIOS — sem eles a API
 * retorna 401 "NOT_FOUND_NAMESPACE".
 *
 * Valores extraídos do runtime config do site playinzoi.com (Nuxt.js):
 *   public.api.baseURL   → https://api-foc.krafton.com
 *   public.api.namespace → inZOI_Official-24ea
 *   public.api.game      → inzoi
 *
 * ⚠️  O namespace (hash "24ea") pode mudar a cada deploy do site.
 *     Se a API voltar a dar 401, atualize API_NAMESPACE com o valor
 *     atualizado — inspecione window.__NUXT__.public.api.namespace no
 *     console do navegador em playinzoi.com.
 *
 *     Ou configure via variável de ambiente:
 *       KRAFTON_NAMESPACE=inZOI_Official-xxxx
 */
const API_NAMESPACE_FALLBACK = "inZOI_Official-24ea";
const API_GAME_FALLBACK = "inzoi";

/**
 * Tenta extrair o namespace e game do runtime config do site playinzoi.com.
 *
 * O site é uma app Nuxt.js que expõe window.__NUXT__.public.api com
 * namespace, game e baseURL. Esta função busca esses metadados no HTML
 * para obter os valores atualizados (o hash do namespace muda a cada deploy).
 *
 * @returns {Promise<{namespace: string, game: string}>}
 */
async function discoverApiConfig() {
  // Prioridade: variáveis de ambiente > auto-descoberta > fallback
  const envNs = process.env.KRAFTON_NAMESPACE;
  const envGame = process.env.KRAFTON_GAME;

  if (envNs && envGame) {
    log(LOG_PREFIX.INFO, "Usando namespace/game das variáveis de ambiente");
    return { namespace: envNs, game: envGame };
  }

  try {
    log(LOG_PREFIX.INFO, "Auto-descobrindo configuração da API em playinzoi.com...");
    const controller = timeoutSignal(15_000);
    const resp = await fetch("https://playinzoi.com/pt-br/news", {
      headers: {
        "User-Agent": "KraftonRSS-Agent/1.0",
        "Accept": "text/html",
      },
      signal: controller.signal,
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const html = await resp.text();

    // Extrai namespace do HTML — busca padrões como:
    // namespace:"inZOI_Official-24ea"
    // ou "namespace":"inZOI_Official-24ea"
    const nsMatch = html.match(/namespace\s*["':]+\s*["']?([^"',&\s]+)/i);
    const gameMatch = html.match(/game\s*["':]+\s*["']?([^"',&\s]+)/i);

    const ns = envNs || (nsMatch ? nsMatch[1] : null);
    const game = envGame || (gameMatch ? gameMatch[1] : null);

    if (ns && game) {
      log(LOG_PREFIX.OK, `Config descoberta: namespace=${ns}, game=${game}`);
      return { namespace: ns, game };
    }

    log(LOG_PREFIX.WARN, "Não foi possível extrair namespace/game do HTML — usando fallback");
  } catch (err) {
    log(LOG_PREFIX.WARN, `Falha ao descobrir config: ${err.message} — usando fallback`);
  }

  return {
    namespace: envNs || API_NAMESPACE_FALLBACK,
    game: envGame || API_GAME_FALLBACK,
  };
}

/** Configuração descoberta (preenchida em run()) */
let API_NAMESPACE = API_NAMESPACE_FALLBACK;
let API_GAME = API_GAME_FALLBACK;

/**
 * Retorna os headers para a requisição da API.
 * Usa os valores de namespace/game descobertos dinamicamente.
 * @returns {object}
 */
function getApiHeaders() {
  return {
    "Accept": "application/hal+json, application/json",
    "Content-Type": "application/json",
    "Origin": "https://playinzoi.com",
    "Referer": "https://playinzoi.com/pt-br/news",
    "User-Agent": "KraftonRSS-Agent/1.0 (+https://github.com)",
    // Headers de roteamento do API Gateway — OBRIGATÓRIOS
    "service-lang": "pt-br",
    "service-namespace": API_NAMESPACE,
    "service-game": API_GAME,
  };
}

/** Timeout da requisição (ms) */
const FETCH_TIMEOUT_MS = 30_000;

/** Número máximo de tentativas por requisição */
const MAX_RETRIES = 3;

/** Delay base para backoff exponencial (ms) */
const RETRY_BASE_DELAY_MS = 1_000;

/** Limite de posts mantidos no histórico local */
const MAX_POSTS = 300;

/** Número máximo de páginas a buscar (segurança — evita loop infinito) */
const MAX_PAGES = 50;

/** Caminho para o arquivo de histórico */
const POSTS_FILE = join(ROOT, "data", "posts.json");

/** Caminho para o RSS de saída */
const RSS_FILE = join(ROOT, "public", "rss.xml");

/**
 * Template para a URL pública de cada notícia.
 *
 * Campos disponíveis: {category}, {postId}, {identifier}, {lang}
 *
 * URLs conhecidas (playinzoi.com — subsidiária KRAFTON):
 *   https://playinzoi.com/pt-br/news/{category}/{postId}
 *
 * Ajuste conforme a estrutura real do site.
 */
const URL_TEMPLATE = "https://playinzoi.com/{lang}/news/{category}/{postId}";

/** Metadados do feed RSS */
const FEED_META = {
  title: "KRAFTON / inZOI News (pt-br)",
  description:
    "Últimas notícias da KRAFTON e inZOI — feed gerado automaticamente a partir da API oficial. " +
    "Inclui patch notes, anúncios, novos itens e mais.",
  link: "https://playinzoi.com/pt-br/news",
  language: "pt-br",
  /** URL real do GitHub Pages (a pasta public/ vai para raiz do site) */
  feedUrl: "https://carolslima.github.io/krafton-inzoi-rss/rss.xml",
};

// ---------------------------------------------------------------------------
// Utilidades de log
// ---------------------------------------------------------------------------

const LOG_PREFIX = {
  INFO: "[INFO]",
  WARN: "[WARN]",
  ERROR: "[ERROR]",
  OK: "[OK]",
};

function ts() {
  return new Date().toISOString();
}

function log(level, ...args) {
  console.log(`${ts()} ${level}`, ...args);
}

// ---------------------------------------------------------------------------
// Escape XML
// ---------------------------------------------------------------------------

/**
 * Escapa caracteres especiais para conteúdo XML.
 */
function escapeXml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Envolve texto em CDATA quando necessário (contém <, > ou &).
 * Trata corretamente sequências "]]>" dentro do texto.
 */
function cdata(str) {
  if (typeof str !== "string") return "";
  const needsCdata = /[<>&]/.test(str);
  if (needsCdata) {
    const safe = str.replace(/]]>/g, "]]]]><![CDATA[>");
    return `<![CDATA[${safe}]]>`;
  }
  return escapeXml(str);
}

/**
 * Gera tag <enclosure> para imagens (compatível com Feedly, Thunderbird, etc.).
 */
function enclosureTag(url) {
  if (!url || typeof url !== "string") return "";
  return `<enclosure url="${escapeXml(url)}" type="image/jpeg"/>`;
}

// ---------------------------------------------------------------------------
// Fetch com timeout, retry e backoff
// ---------------------------------------------------------------------------

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`Timeout após ${ms}ms`)), ms);
  return controller;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa fetch com retry automático e backoff exponencial.
 *
 * @param {string} url
 * @returns {Promise<object>} corpo da resposta parseado como JSON
 */
async function fetchWithRetry(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log(LOG_PREFIX.INFO, `Tentativa ${attempt}/${MAX_RETRIES} — GET ${url}`);

      const controller = timeoutSignal(FETCH_TIMEOUT_MS);

      const resp = await fetch(url, {
        method: "GET",
        headers: getApiHeaders(),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "(sem corpo)");
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${body.slice(0, 300)}`);
      }

      const json = await resp.json();
      log(LOG_PREFIX.OK, `Resposta recebida (${attempt}/${MAX_RETRIES})`);
      return json;

    } catch (err) {
      lastError = err;

      if (err.name === "AbortError") {
        log(LOG_PREFIX.WARN, `Timeout na tentativa ${attempt}`);
      } else {
        log(LOG_PREFIX.ERROR, `Falha na tentativa ${attempt}: ${err.message}`);
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        log(LOG_PREFIX.INFO, `Aguardando ${delay}ms antes da próxima tentativa...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Todas as ${MAX_RETRIES} tentativas falharam. Último erro: ${lastError?.message}`
  );
}

// ---------------------------------------------------------------------------
// Consulta da API com paginação automática
// ---------------------------------------------------------------------------

/**
 * Constrói a URL da API para uma página específica.
 * @param {number} page — número da página (1-based)
 * @returns {string}
 */
function buildApiUrl(page) {
  return `${API_BASE}?${API_PARAMS}&size=${API_PAGE_SIZE}&page=${page}`;
}

/**
 * Busca TODAS as páginas da API e retorna os posts agregados.
 *
 * A API usa HAL+JSON com paginação:
 *   page.totalPages  → total de páginas
 *   _links.next.href → URL da próxima página
 *
 * @returns {Promise<Array<object>>} array de posts crus da API
 */
async function fetchAllPosts() {
  const allPosts = [];

  // Busca a primeira página para descobrir o total
  const firstPageUrl = buildApiUrl(1);
  const firstPage = await fetchWithRetry(firstPageUrl);

  // Extrai posts da primeira página (formato HAL: _embedded.post)
  const firstBatch = extractPosts(firstPage);
  allPosts.push(...firstBatch);

  // Descobre quantas páginas existem
  const totalPages = firstPage?.page?.totalPages ?? 1;
  const totalElements = firstPage?.page?.totalElements ?? firstBatch.length;

  log(LOG_PREFIX.INFO, `Total: ${totalElements} notícias em ${totalPages} página(s)`);

  if (totalPages <= 1) {
    return allPosts;
  }

  // Busca as páginas restantes (2 até totalPages ou MAX_PAGES)
  const pagesToFetch = Math.min(totalPages, MAX_PAGES);

  for (let page = 2; page <= pagesToFetch; page++) {
    const url = buildApiUrl(page);
    try {
      const body = await fetchWithRetry(url);
      const batch = extractPosts(body);
      allPosts.push(...batch);
      log(LOG_PREFIX.INFO, `Página ${page}/${pagesToFetch}: ${batch.length} posts`);
    } catch (err) {
      // Não para tudo se uma página falhar — continua com as demais
      log(LOG_PREFIX.ERROR, `Falha ao buscar página ${page}: ${err.message}`);
    }
  }

  if (totalPages > MAX_PAGES) {
    log(LOG_PREFIX.WARN, `Limitado a ${MAX_PAGES} páginas (de ${totalPages} disponíveis)`);
  }

  return allPosts;
}

// ---------------------------------------------------------------------------
// Extração de dados da resposta da API (formato HAL+JSON)
// ---------------------------------------------------------------------------

/**
 * Extrai o array de posts da resposta HAL+JSON da API.
 *
 * Estrutura real da resposta:
 *   {
 *     _embedded: { post: [...] },
 *     _links: { self, first, next, last },
 *     page: { size, number, totalElements, totalPages }
 *   }
 *
 * Fallbacks para outros formatos comuns caso a API mude.
 *
 * @param {object} body — resposta JSON da API
 * @returns {Array<object>}
 */
function extractPosts(body) {
  if (!body || typeof body !== "object") {
    log(LOG_PREFIX.WARN, "Resposta da API não é um objeto JSON válido");
    return [];
  }

  // Formato principal: HAL+JSON (Spring HATEOAS)
  if (body._embedded && Array.isArray(body._embedded.post)) {
    return body._embedded.post;
  }

  // Formatos alternativos (fallback)
  const candidates =
    body._embedded?.content ??
    body.content ??
    body.data ??
    body.posts ??
    body.items ??
    body.results ??
    null;

  if (Array.isArray(candidates)) {
    return candidates;
  }

  if (Array.isArray(body)) {
    return body;
  }

  log(LOG_PREFIX.WARN, "Não foi possível encontrar o array de posts na resposta");
  log(LOG_PREFIX.INFO, "Chaves disponíveis:", Object.keys(body).join(", "));
  if (body._embedded) {
    log(LOG_PREFIX.INFO, "Chaves em _embedded:", Object.keys(body._embedded).join(", "));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Normalização de posts (API real → formato interno)
// ---------------------------------------------------------------------------

/**
 * Mapeamento de categoria para nome legível em pt-br.
 */
const CATEGORY_LABELS = {
  patch_note: "Patch Note",
  new_items: "Novos Itens",
  announcement: "Anúncio",
  event: "Evento",
  update: "Atualização",
  news: "Notícia",
};

/**
 * Normaliza um post da API para o formato interno.
 *
 * Campos reais da API (verificado em 2026-06-29):
 *   postId           → id único (number)
 *   title            → título
 *   category         → categoria (patch_note, new_items, announcement, ...)
 *   identifier       → "news"
 *   createdAt        → data de criação "YYYY-MM-DD HH:mm:ss"
 *   displayStartTime → data de exibição "YYYY-MM-DD HH:mm:ss"
 *   images[0].imageUrl  → thumbnail URL cheia
 *   images[0].thumbUrl  → thumbnail URL reduzida
 *   totalViewCnt     → contagem de visualizações
 *   postContentId    → ID do conteúdo vinculado
 *   landingType      → "SELF" (abre no próprio site)
 *
 * @param {object} raw — post cru da API
 * @returns {object} post normalizado
 */
function normalizePost(raw) {
  // ID único
  const id = raw.postId ?? raw.id ?? raw.postContentId ?? "";

  // Título
  const title = raw.title ?? "";

  // Categoria
  const category = raw.category ?? raw.identifier ?? "";
  const categoryLabel = CATEGORY_LABELS[category] ?? category;

  // Data de publicação — prefere displayStartTime (quando fica visível)
  const pubDate = raw.displayStartTime ?? raw.createdAt ?? raw.publishedAt ?? "";

  // Thumbnail
  const images = raw.images ?? [];
  const thumbnail =
    images.find((img) => img.key === "thumbnail")?.imageUrl ??
    images[0]?.imageUrl ??
    null;

  // URL pública construída a partir do template
  const lang = raw.lang ?? "pt-br";
  const link = URL_TEMPLATE
    .replace("{category}", String(category))
    .replace("{postId}", String(id))
    .replace("{identifier}", String(raw.identifier ?? "news"))
    .replace("{lang}", String(lang));

  // Descrição — a API de lista não retorna corpo, então montamos com o disponível
  const description = [
    `[${categoryLabel}] ${title}`,
    raw.totalViewCnt ? `${raw.totalViewCnt} visualizações` : "",
  ]
    .filter(Boolean)
    .join(" — ");

  return {
    id: String(id),
    title: String(title),
    description: String(description),
    category: String(category),
    categoryLabel: String(categoryLabel),
    pubDate: String(pubDate),
    thumbnail: thumbnail ? String(thumbnail) : null,
    link: String(link),
    // Metadados internos
    postContentId: raw.postContentId ? String(raw.postContentId) : "",
    totalViewCnt: raw.totalViewCnt ?? 0,
    addedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Chave única para deduplicação
// ---------------------------------------------------------------------------

/**
 * Gera uma chave única para um post.
 * Prioridade: id > link > title+pubDate
 */
function dedupeKey(post) {
  if (post.id) return `id:${post.id}`;
  if (post.link) return `url:${post.link}`;
  return `hash:${post.title}|${post.pubDate}`;
}

// ---------------------------------------------------------------------------
// Gerenciamento do histórico local
// ---------------------------------------------------------------------------

async function readHistory() {
  try {
    const raw = await readFile(POSTS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      log(LOG_PREFIX.WARN, "posts.json não contém um array — resetando");
      return [];
    }
    log(LOG_PREFIX.INFO, `Histórico lido: ${data.length} posts conhecidos`);
    return data;
  } catch (err) {
    if (err.code === "ENOENT") {
      log(LOG_PREFIX.INFO, "posts.json não encontrado — iniciando histórico vazio");
      return [];
    }
    log(LOG_PREFIX.ERROR, `Erro ao ler posts.json: ${err.message}`);
    return [];
  }
}

async function writeHistory(posts) {
  await mkdir(dirname(POSTS_FILE), { recursive: true });
  await writeFile(POSTS_FILE, JSON.stringify(posts, null, 2), "utf-8");
  log(LOG_PREFIX.INFO, `Histórico salvo: ${posts.length} posts`);
}

/**
 * Mescla novos posts ao histórico:
 * 1. Lê o histórico existente
 * 2. Detecta posts inéditos via dedupeKey()
 * 3. Adiciona os novos no topo
 * 4. Ordena por data decrescente
 * 5. Limita ao máximo configurado (MAX_POSTS)
 *
 * @param {Array<object>} incoming — posts da API já normalizados
 * @returns {Promise<{history: Array<object>, newPosts: Array<object>}>}
 */
async function mergeHistory(incoming) {
  const history = await readHistory();
  const seen = new Set(history.map((p) => dedupeKey(p)));

  const newPosts = [];
  for (const post of incoming) {
    const key = dedupeKey(post);
    if (!seen.has(key)) {
      seen.add(key);
      newPosts.push(post);
    }
  }

  if (newPosts.length > 0) {
    log(LOG_PREFIX.INFO, `${newPosts.length} novas notícias detectadas`);
    const merged = [...newPosts, ...history];
    // Ordena por data decrescente
    merged.sort((a, b) => {
      const da = new Date(a.pubDate || a.addedAt || 0);
      const db = new Date(b.pubDate || b.addedAt || 0);
      return db - da;
    });
    const trimmed = merged.slice(0, MAX_POSTS);
    await writeHistory(trimmed);
    return { history: trimmed, newPosts };
  }

  log(LOG_PREFIX.INFO, "Nenhuma notícia nova detectada");
  return { history, newPosts: [] };
}

// ---------------------------------------------------------------------------
// Geração do RSS 2.0
// ---------------------------------------------------------------------------

/**
 * Converte data para formato RFC 822 (padrão RSS 2.0).
 * Aceita ISO 8601 e "YYYY-MM-DD HH:mm:ss".
 */
function toRfc822(dateStr) {
  try {
    // A API retorna "YYYY-MM-DD HH:mm:ss" (sem timezone)
    // Adiciona 'Z' se não tiver offset
    const normalized = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T") + "Z";
    const d = new Date(normalized);
    if (isNaN(d.getTime())) throw new Error("Data inválida");
    return d.toUTCString();
  } catch {
    return new Date().toUTCString();
  }
}

/**
 * Gera o XML completo do feed RSS 2.0.
 */
function generateRssXml(posts) {
  const { title, description, link, language, feedUrl } = FEED_META;

  const items = posts
    .map((p) => {
      const guid = p.link || `urn:krafton:post:${p.id}`;
      const pubDate = toRfc822(p.pubDate || p.addedAt);
      const enclosure = enclosureTag(p.thumbnail);

      // Descrição enriquecida com thumbnail inline
      let descContent = cdata(p.description || p.title);
      if (p.thumbnail) {
        descContent += `<br/><img src="${escapeXml(p.thumbnail)}" alt="${escapeXml(p.title)}" style="max-width:100%;"/>`;
      }

      // Linhas de cada <item>
      const lines = [
        `    <item>`,
        `      <title>${cdata(p.title)}</title>`,
        `      <description>${descContent}</description>`,
        `      <link>${escapeXml(guid)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(guid)}</guid>`,
        `      <pubDate>${pubDate}</pubDate>`,
        `      <category>${escapeXml(p.categoryLabel || p.category || "")}</category>`,
      ];

      if (enclosure) {
        lines.push(`      ${enclosure}`);
      }

      lines.push(`    </item>`);
      return lines.join("\n");
    })
    .join("\n");

  const now = toRfc822(new Date().toISOString());

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">`,
    `  <channel>`,
    `    <title>${escapeXml(title)}</title>`,
    `    <description>${escapeXml(description)}</description>`,
    `    <link>${escapeXml(link)}</link>`,
    `    <language>${language}</language>`,
    `    <lastBuildDate>${now}</lastBuildDate>`,
    `    <generator>KRAFTON RSS Generator (Node.js) — github.com</generator>`,
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>`,
    items,
    `  </channel>`,
    `</rss>`,
  ].join("\n");
}

async function writeRss(xml) {
  await mkdir(dirname(RSS_FILE), { recursive: true });
  await writeFile(RSS_FILE, xml, "utf-8");
  log(LOG_PREFIX.OK, `RSS gerado: ${RSS_FILE}`);
}

// ---------------------------------------------------------------------------
// Pipeline principal
// ---------------------------------------------------------------------------

/**
 * Executa o pipeline completo:
 * 1. Consulta a API (todas as páginas)
 * 2. Normaliza os posts
 * 3. Mescla com histórico (detecta novos)
 * 4. Gera o RSS com TODO o histórico
 * 5. Salva o XML
 *
 * @returns {Promise<{changed: boolean, newCount: number, totalCount: number}>}
 */
async function run() {
  log(LOG_PREFIX.INFO, "=== KRAFTON / inZOI RSS Generator ===");
  log(LOG_PREFIX.INFO, `API: ${API_BASE}`);

  // 0. Auto-descobrir configuração da API (namespace/game)
  const config = await discoverApiConfig();
  API_NAMESPACE = config.namespace;
  API_GAME = config.game;

  // 1. Consultar API (todas as páginas)
  log(LOG_PREFIX.INFO, "Consultando API (todas as páginas)...");
  let rawPosts;
  try {
    rawPosts = await fetchAllPosts();
  } catch (err) {
    log(LOG_PREFIX.ERROR, `Falha ao consultar API: ${err.message}`);
    log(LOG_PREFIX.WARN, "API indisponível — usando histórico local para gerar RSS...");

    const history = await readHistory();
    if (history.length > 0) {
      const xml = generateRssXml(history);
      await writeRss(xml);
      log(LOG_PREFIX.OK, `RSS gerado do histórico (${history.length} posts) — sem atualização da API`);
      return { changed: false, newCount: 0, totalCount: history.length };
    }

    log(LOG_PREFIX.ERROR, "Sem histórico e sem API — nada a fazer");
    throw err;
  }

  log(LOG_PREFIX.INFO, `Total de posts recebidos da API: ${rawPosts.length}`);

  if (rawPosts.length === 0) {
    log(LOG_PREFIX.WARN, "API retornou zero posts — encerrando sem alterações");
    const history = await readHistory();
    if (history.length > 0) {
      const xml = generateRssXml(history);
      await writeRss(xml);
      return { changed: false, newCount: 0, totalCount: history.length };
    }
    return { changed: false, newCount: 0, totalCount: 0 };
  }

  // 2. Normalizar posts (só os que têm título ou id)
  const incoming = rawPosts.map(normalizePost).filter((p) => p.title || p.id);

  // 3. Mesclar com histórico
  const { history, newPosts } = await mergeHistory(incoming);

  // 4. Gerar RSS com todo o histórico
  const xml = generateRssXml(history);
  await writeRss(xml);

  // 5. Resultado
  const changed = newPosts.length > 0;
  if (changed) {
    log(LOG_PREFIX.OK, `RSS atualizado — ${newPosts.length} novos posts detectados`);
  } else {
    log(LOG_PREFIX.OK, "Nenhuma alteração no RSS");
  }

  log(LOG_PREFIX.INFO, `Total de posts no feed: ${history.length}`);
  return { changed, newCount: newPosts.length, totalCount: history.length };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

run()
  .then((result) => {
    log(LOG_PREFIX.INFO, "Concluído com sucesso");
    if (result.changed) {
      log(LOG_PREFIX.INFO, "ALTERADO=true — commit necessário");
    }
    process.exit(0);
  })
  .catch((err) => {
    log(LOG_PREFIX.ERROR, `Falha crítica: ${err.message}`);
    // NÃO faz exit(1) — o workflow do GitHub Actions continua funcionando
    process.exit(0);
  });
