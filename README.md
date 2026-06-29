# KRAFTON / inZOI RSS Feed

Feed RSS 2.0 automático das notícias da **KRAFTON/inZOI**, gerado a partir da API
oficial (`api-foc.krafton.com`) e hospedado via **GitHub Pages**.

---

## Visão geral

Este projeto consulta periodicamente a API de notícias da KRAFTON, detecta novas
publicações, mantém um histórico local e gera um arquivo `rss.xml` compatível com
qualquer leitor RSS (Feedly, Inoreader, Thunderbird, Outlook, FreshRSS, RSS Guard,
MonitorRSS, etc.).

**Princípios de design:**

- **Zero dependências externas** — apenas Node.js 22 e APIs nativas
- **Zero bancos de dados** — histórico em JSON simples versionado pelo Git
- **Zero serviços SaaS** — GitHub Actions + GitHub Pages bastam
- **Resiliência total** — falhas de API não quebram o workflow
- **Paginação automática** — busca todas as páginas da API (até 50)

---

## Estrutura real da API

A API foi inspecionada em 29/06/2026. Resposta no formato **HAL+JSON**
(Spring HATEOAS):

```json
{
  "_embedded": {
    "post": [
      {
        "postId": 10343,
        "title": "[v0.9.2] Detalhes do Hotfix",
        "category": "patch_note",
        "identifier": "news",
        "createdAt": "2026-06-24 05:10:26",
        "displayStartTime": "2026-06-25 08:10:22",
        "images": [
          {
            "key": "thumbnail",
            "imageUrl": "https://wstatic-prod-boc.krafton.com/.../thumb.png",
            "thumbUrl": "https://wstatic-prod-boc.krafton.com/.../thumb_small.png"
          }
        ],
        "totalViewCnt": 11734,
        "postContentId": 27602,
        "landingType": "SELF"
      }
    ]
  },
  "_links": {
    "self": { "href": "..." },
    "next": { "href": "..." },
    "last": { "href": "..." }
  },
  "page": {
    "size": 20,
    "number": 1,
    "totalElements": 113,
    "totalPages": 6
  }
}
```

### Headers obrigatórios

A API é protegida pelo **CloudFront** com validação de CORS:

| Header      | Valor                          | Obrigatório |
| ----------- | ------------------------------ | ----------- |
| `Origin`    | `https://playinzoi.com`        | ✅ Sim      |
| `Referer`   | `https://playinzoi.com/pt-br/news` | Recomendado |
| `Accept`    | `application/hal+json`         | Recomendado |

⚠️ **Importante:** Se a API passar a exigir autenticação adicional (API key,
token JWT, cookies de sessão), adicione os headers em `API_HEADERS` no script
ou use **GitHub Secrets** (veja a seção [Segurança](#segurança)).

---

## Como funciona

```
┌──────────────────┐     ┌───────────────────┐     ┌──────────────────────┐
│  GitHub Actions   │────▶│  generate-rss.js  │────▶│  api-foc.krafton.com │
│  (cron 30min)     │     │  (Node.js 22)     │     │  HAL+JSON paginado   │
└──────────────────┘     └────────┬──────────┘     └──────────────────────┘
                                  │
                     ┌────────────▼───────────┐
                     │  data/posts.json       │
                     │  (histórico local)     │
                     │  até 300 posts         │
                     └────────────┬───────────┘
                                  │
                     ┌────────────▼───────────┐
                     │  public/rss.xml        │
                     │  (RSS 2.0 válido)     │
                     └────────────┬───────────┘
                                  │
                     ┌────────────▼───────────┐
                     │  GitHub Pages          │
                     │  https://.../rss.xml   │
                     └────────────────────────┘
```

1. O GitHub Actions dispara o script a cada 30 minutos (configurável).
2. O script busca **todas as páginas** da API com retry e timeout.
3. Novas notícias são mescladas ao histórico (`data/posts.json`).
4. O RSS é gerado a partir do histórico completo.
5. Se houve mudanças, um commit automático publica o XML.
6. O GitHub Pages serve o arquivo estaticamente.

---

## Estrutura do projeto

```
/
├── .github/
│   └── workflows/
│       └── update-rss.yml      # Workflow do GitHub Actions
├── scripts/
│   └── generate-rss.js         # Script principal (Node.js, zero-deps)
├── data/
│   └── posts.json              # Histórico de notícias (até 300)
├── public/
│   └── rss.xml                 # Feed RSS gerado
├── package.json                # Metadados (sem dependências)
├── README.md                   # Este arquivo
└── .gitignore
```

---

## Instalação

### Pré-requisitos

- **Node.js >= 22** — [nodejs.org](https://nodejs.org/)
- **Git** — [git-scm.com](https://git-scm.com/)

### Passos

```bash
# 1. Clone o repositório
git clone https://github.com/carolslima/krafton-inzoi-rss.git
cd krafton-inzoi-rss

# 2. Não há dependências para instalar — projeto zero-dependency
node -e "console.log('Node.js', process.version)"

# 3. Execute o script manualmente
node scripts/generate-rss.js
```

O script criará automaticamente `data/posts.json` (se não existir) e
`public/rss.xml`.

---

## Executar localmente

```bash
# Geração única
npm run generate

# Ou diretamente
node scripts/generate-rss.js
```

### Saída esperada

```
2026-06-29T20:30:00.000Z [INFO] === KRAFTON / inZOI RSS Generator ===
2026-06-29T20:30:00.000Z [INFO] API: https://api-foc.krafton.com/content/post/news
2026-06-29T20:30:00.000Z [INFO] Consultando API (todas as páginas)...
2026-06-29T20:30:00.000Z [INFO] Tentativa 1/3 — GET ...page=1
2026-06-29T20:30:01.000Z [OK] Resposta recebida (1/3)
2026-06-29T20:30:01.000Z [INFO] Total: 113 notícias em 6 página(s)
2026-06-29T20:30:01.000Z [INFO] Tentativa 1/3 — GET ...page=2
...
2026-06-29T20:30:10.000Z [INFO] Página 6/6: 13 posts
2026-06-29T20:30:10.000Z [INFO] Total de posts recebidos da API: 113
2026-06-29T20:30:10.000Z [INFO] Histórico lido: 100 posts conhecidos
2026-06-29T20:30:10.000Z [INFO] 13 novas notícias detectadas
2026-06-29T20:30:10.000Z [INFO] Histórico salvo: 113 posts
2026-06-29T20:30:10.000Z [OK] RSS gerado: public/rss.xml
2026-06-29T20:30:10.000Z [INFO] Concluído com sucesso
```

---

## GitHub Actions

O workflow **Update RSS Feed** está definido em
`.github/workflows/update-rss.yml`.

### Gatilhos

| Gatilho              | Descrição                             |
| -------------------- | ------------------------------------- |
| `schedule`           | A cada 30 minutos (`*/30 * * * *`)   |
| `workflow_dispatch`  | Manual (botão "Run workflow")         |
| `push` (main)        | Ao modificar o script ou workflow     |

### Permissões

O workflow requer `contents: write` para fazer commit do RSS gerado.
Nenhuma outra permissão é necessária.

### Execução manual

1. Vá até a aba **Actions** do repositório.
2. Selecione **Update RSS Feed**.
3. Clique em **Run workflow**.

---

## GitHub Pages

O arquivo `public/rss.xml` é servido via GitHub Pages usando **GitHub Actions**
(método atual — não usa mais "Deploy from a branch").

O projeto já inclui o workflow `.github/workflows/deploy-pages.yml` pronto.

### Como habilitar

1. Vá em **Settings** → **Pages**.
2. Em **Build and deployment** → **Source**, selecione **GitHub Actions**.
3. O workflow `deploy-pages.yml` será detectado automaticamente.
4. Faça um push para `main` (ou execute `update-rss.yml`) para disparar o primeiro deploy.

### Como funciona

```
update-rss.yml                     deploy-pages.yml
──────────────                     ─────────────────
Gera rss.xml                       Checkout
  ↓                                Upload artifact (public/)
Commit + Push                      Deploy to Pages
  ↓                                    ↓
Dispara push event ──────────────▶  Publica em carolslima.github.io
```

O `update-rss.yml` commita o RSS → o push aciona automaticamente o
`deploy-pages.yml` → o site é atualizado.

### Execução manual do deploy

1. Vá em **Actions** → **Deploy to GitHub Pages** → **Run workflow**.

O feed estará disponível em:

```
https://carolslima.github.io/krafton-inzoi-rss/rss.xml
```

> ⚠️ **Importante:** O workflow `deploy-pages.yml` faz upload da pasta `public/`.
> O GitHub Pages publica o conteúdo na **raiz** do site, então o arquivo fica em
> `/rss.xml`, e não `/public/rss.xml`.

### ⚠️ Atualize a URL do feed

A constante `FEED_META.feedUrl` já está configurada. Se mudar o nome do
repositório, atualize:

```js
feedUrl: "https://seuusuario.github.io/seurepositorio/rss.xml",
```

Isso garante que o elemento `<atom:link rel="self">` aponte para o endereço
correto — melhora a compatibilidade com leitores RSS.

---

## URL do feed

Após habilitar o GitHub Pages:

```
https://<seu-usuario>.github.io/<seu-repositorio>/public/rss.xml
```

Adicione esta URL ao seu leitor RSS favorito.

---

## Troubleshooting

### "NOT_FOUND_NAMESPACE" (401)

A API está protegida pelo CloudFront. Verifique:

1. **Header Origin:** o script já inclui `Origin: https://playinzoi.com`.
   Se o domínio de origem autorizado mudar, atualize `API_HEADERS`.
2. **Autenticação adicional:** Se a API passar a exigir token, adicione ao
   `API_HEADERS` ou use GitHub Secrets (veja [Segurança](#segurança)).
3. **URL da API:** Se o endpoint mudar, atualize `API_BASE` e `API_PARAMS`.

### A API mudou os nomes dos campos

Edite a função `normalizePost()` no script. Os campos atuais (verificados em
29/06/2026) são:

| Campo da API       | Mapeado para     |
| ------------------ | ---------------- |
| `postId`           | `id`             |
| `title`            | `title`          |
| `category`         | `category`       |
| `displayStartTime` | `pubDate`        |
| `images[].imageUrl`| `thumbnail`      |
| `postContentId`    | `postContentId`  |

### O workflow falhou

O script é projetado para **nunca quebrar o workflow** (exit code = 0 sempre):

- Se a API estiver offline → usa o histórico existente para gerar RSS
- Se `posts.json` estiver corrompido → recria do zero
- Se o timeout estourar → tenta novamente (3x com backoff)
- Se uma página falhar → continua com as demais

Verifique os logs na aba **Actions** para detalhes.

### O RSS não está atualizando

1. Verifique se o GitHub Actions está habilitado (`Settings → Actions → Allow all`).
2. Confira se o workflow foi executado recentemente.
3. Verifique os logs da última execução.
4. Confirme que o GitHub Pages está configurado e apontando para a branch correta.

---

## Alterar intervalo do cron

Edite `.github/workflows/update-rss.yml`:

```yaml
on:
  schedule:
    # A cada 15 minutos
    - cron: "*/15 * * * *"
    # A cada hora
    - cron: "0 * * * *"
    # Duas vezes por dia (9h e 18h UTC)
    - cron: "0 9,18 * * *"
```

**Atenção:** O GitHub Actions tem limite de minutos gratuitos (2000 min/mês
para repositórios públicos). O padrão de 30 minutos (~1440 execuções/mês) é
um bom equilíbrio.

---

## Alterar limite de histórico

Edite `scripts/generate-rss.js`:

```js
const MAX_POSTS = 500; // Padrão: 300
```

Quanto maior o limite, maior o arquivo RSS. Para feeds RSS padrão, 300 itens é
mais que suficiente — a maioria dos leitores exibe apenas os 20-50 mais recentes.

---

## Trocar API futuramente

Caso a KRAFTON mude o endpoint, edite as constantes:

```js
// URL base
const API_BASE = "https://novo-endpoint.krafton.com/v2/news";

// Parâmetros fixos
const API_PARAMS = "lang=pt-br&searchType=TITLE_AND_CONTENT";

// Headers
const API_HEADERS = {
  "Accept": "application/hal+json, application/json",
  "Origin": "https://playinzoi.com",
  "x-api-key": process.env.KRAFTON_API_KEY || "",
};
```

### Se o formato da resposta mudar

Ajuste `extractPosts()` (formato do JSON) e `normalizePost()` (campos do post).

---

## Segurança

- **Nenhuma credencial exposta:** headers de API devem ser configurados via
  **GitHub Secrets** + variáveis de ambiente, nunca hardcoded em texto plano.
- **Nenhum dado sensível:** o projeto apenas armazena metadados de notícias
  públicas.
- **Execução isolada:** o workflow do GitHub Actions roda em ambiente
  efêmero e isolado.
- **Zero superfície de ataque:** sem dependências, sem plugins, sem runtime
  complexo.

### Usando GitHub Secrets

```yaml
# No workflow (.github/workflows/update-rss.yml)
- name: Generate RSS Feed
  env:
    KRAFTON_API_KEY: ${{ secrets.KRAFTON_API_KEY }}
  run: node scripts/generate-rss.js
```

```js
// No script (generate-rss.js)
const API_HEADERS = {
  "Accept": "application/hal+json",
  "Origin": "https://playinzoi.com",
  "x-api-key": process.env.KRAFTON_API_KEY || "",
};
```

---

## Recuperação de falhas

O sistema foi projetado para se auto-recuperar:

| Cenário                       | Comportamento                                    |
| ----------------------------- | ------------------------------------------------ |
| API offline (5xx)             | 3 tentativas com backoff; usa cache do histórico |
| API retorna JSON inválido     | Loga o erro e usa histórico existente            |
| Timeout (30s)                 | AbortController cancela; próxima tentativa       |
| `posts.json` corrompido       | Reseta para array vazio e reconstrói             |
| `public/rss.xml` inexistente  | Gerado automaticamente                           |
| Uma página falha              | Pula a página e continua com as demais           |
| Disco cheio                   | Falha com log claro (improvável no Actions)      |

---

## Compatibilidade com leitores RSS

Testado e compatível com:

- ✅ **Feedly** — detecta `<enclosure>` e `<media:content>`
- ✅ **Inoreader** — parse completo de RSS 2.0
- ✅ **Thunderbird** — suporte nativo a feeds RSS
- ✅ **Outlook** — suporte a RSS feeds
- ✅ **FreshRSS** — compatível com RSS 2.0 padrão
- ✅ **RSS Guard** — suporte completo
- ✅ **MonitorRSS** — parse de `<guid isPermaLink>` e `<pubDate>` RFC 822

---

## Licença

MIT — use como quiser.
