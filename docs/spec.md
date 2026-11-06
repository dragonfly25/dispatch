# Dispatch — Specifica funzionale (il COSA)

Nov 6, 2026 · @Vincenzo

## 1. Visione e obiettivo

Dispatch è un layer installabile in qualsiasi repository che permette a chi possiede più subscription AI (Anthropic, OpenAI, Google) di lavorare da un solo client e distribuire i task degli agenti sugli altri provider, bilanciando il consumo delle quote settimanali.

**Problema che risolve.** Chi paga tre abbonamenti li usa uno alla volta: quando il primo raggiunge il limite, il lavoro si ferma anche se gli altri due hanno quota disponibile. Non esiste oggi un modo per far collaborare i tre strumenti sullo stesso progetto senza cambiare client o riscrivere il proprio setup.

**Cosa ottiene l'utente.**

- Continua a lavorare nel client che preferisce (Claude Code, Codex CLI, Antigravity CLI): quella sessione resta l'orchestratore.
- I task delegabili vengono eseguiti da agenti esterni sugli altri provider e il risultato torna all'orchestratore.
- La scelta del provider segue regole configurabili: quota residua, competenza, costo, preferenze esplicite.
- Il suo setup esistente (skill, sub-agent, CLAUDE.md, AGENTS.md) non viene modificato.
- Chi non usa agenti non vede alcuna differenza.

**Cosa NON è.** Non è un nuovo framework agentico, non è un proxy di API, non usa API key al posto delle subscription (salvo opt-in esplicito), non sostituisce l'orchestratore.

**Questo documento descrive il COSA.** Linguaggio, architettura interna, librerie e struttura del codice sono decisioni di chi implementa, con i soli vincoli indicati nella sezione 2.

## 2. Principi e invarianti non negoziabili

Queste regole valgono in ogni componente e in ogni configurazione. Una scelta implementativa che ne viola una è sbagliata.

1. **L'orchestratore non invoca mai se stesso via script.** Il provider del client in uso esegue i propri sub-agent in modo nativo; Dispatch interviene solo per spostare lavoro su un provider *diverso* dal host. Unica eccezione opt-in: un secondo account dello stesso provider o un pool API separato, trattati come provider esterni.
2. **Solo CLI ufficiali, in modalità headless.** Gli agenti esterni vengono lanciati tramite i CLI dei provider (`claude`, `codex`, `agy`) con le subscription già autenticate. Nessuna chiamata diretta alle API con le credenziali OAuth dell'utente, nessun reverse engineering dei protocolli di chat.
3. **Nessuna modifica al setup dell'utente.** Skill, sub-agent, CLAUDE.md, AGENTS.md e codice del progetto restano intatti. Dispatch aggiunge i propri file e, dove necessario, una voce nelle config hook/agent del host, in append, con marker, rimovibile con `uninstall`.
4. **Trasparente per chi non usa agenti.** Un collaboratore che clona la repo senza Dispatch installato non vede errori né cambiamenti di comportamento.
5. **Tutto configurabile, con default sensati.** Ogni comportamento (routing, mapping modelli, effort, sicurezza, quote) è esposto in configurazione. I preset sono file di configurazione precompilati, mai logica nascosta.
6. **Decisioni spiegabili.** Ogni scelta di routing deve poter essere mostrata all'utente con la regola che l'ha prodotta (`explain`). Nessuna decisione al buio non loggata.
7. **Fallimento sicuro.** Se un provider esterno fallisce, non risponde o è a quota esaurita, il task torna all'orchestratore o passa al provider successivo secondo la policy; mai perso silenziosamente.
8. **Isolamento di default.** Gli agenti esterni lavorano in un worktree dedicato e restituiscono patch; la scrittura diretta nella working copy è opt-in.
9. **Provider e regole di billing sono dati, non assunti.** I canali per leggere le quote e i pool di consumo cambiano senza preavviso: vanno isolati in adapter versionati e sostituibili.
10. **Documentazione e codice in inglese.** Il progetto è pensato per essere pubblicato su GitHub e usato da chiunque.

## 3. Componenti funzionali

&#91;embedded content: architettura ext-agent · host, core, tre adapter, ritorno del risultato\]

Il host delega un task; l'integrazione lo passa al core, che sceglie un provider diverso dal host e lo esegue tramite l'adapter in un worktree; il risultato torna al host come patch, log, esito e uso stimato.

| Componente | Responsabilità | Input → Output |
| --- | --- | --- |
| **CLI `dispatch`** | Punto d'ingresso unico: `run`, `install`, `uninstall`, `doctor`, `status`, `watch`, `use`, `explain`, `validate` | comandi utente → azioni, JSON su stdout quando richiesto |
| **Host integration** | Rende Dispatch disponibile dentro ogni client, senza toccare il setup dell'utente (sezione 5) | evento del host → chiamata a `run` |
| **Router** | Applica profilo, regole, pin, mapping e stato quote; produce una decisione spiegabile (sezione 7) | task + contesto → provider, modello, effort, motivazione |
| **Quota module** | Legge l'uso reale dove possibile, stima dove no, registra ogni esecuzione (sezione 8) | provider → % usata, reset, affidabilità del dato |
| **Adapter** | Uno per provider: lancia il CLI headless, normalizza eventi e risultato in un contratto unico (sezione 4) | task normalizzato → JSON risultato + stream eventi |
| **Execution sandbox** | Worktree isolato per task, timeout, scope dei permessi, raccolta patch (sezione 9) | adapter → patch verificata |
| **Config** | Schema unico validato: globale (`~/.dispatch/`) e per repo (`.dispatch/`) | file yaml → configurazione effettiva |
| **Log & shadow** | Ogni decisione e ogni esecuzione loggate; registra cosa avrebbero scelto gli altri profili | esecuzioni → `state/`, report per `status` |

**Contratto dell'adapter (fisso per tutti i provider).** Input: descrizione del task, contesto (file rilevanti, vincoli), tier/effort risolti, scope dei permessi, timeout, directory del worktree. Output: esito (`success` / `failed` / `timeout` / `quota_exhausted`), patch in formato git, log sintetico dei passi, riassunto strutturato per l'orchestratore, uso stimato (token o % se disponibile), durata. Durante l'esecuzione: stream di eventi normalizzati (`reading`, `editing`, `running`, `thinking`, `done`) con lo stesso vocabolario per tutti i provider.

## 4. Provider supportati e vincoli noti (verificati a novembre 2026)

Tre provider al lancio, con un'architettura che permette di aggiungerne altri (OpenCode, Copilot CLI, un secondo account dello stesso provider) scrivendo solo un nuovo adapter.

| Provider | CLI | Headless | Eventi in stream | Hook | Lettura quote | Note |
| --- | --- | --- | --- | --- | --- | --- |
| Anthropic | `claude` (Claude Code) | `claude -p` | `--output-format stream-json` | Sì, ma non intercettano lo spawn dei sub-agent | Endpoint OAuth non documentato: % reale e reset per finestra 5h e 7g | `claude -p` attinge oggi alla subscription; il cambio annunciato per giugno 2026 è stato sospeso. Max/Team hanno anche crediti API mensili usabili con API key (pool separato, opt-in) |
| OpenAI | `codex` (Codex CLI) | `codex exec --json` | JSONL | Sì (`~/.codex/hooks.json`, feature flag), con `PreToolUse` + `updatedInput` e `SubagentStart/Stop` | `codex app-server` JSON-RPC `account/rateLimits/read` | Richiede repo git o `--skip-git-repo-check` |
| Google | `agy` (Antigravity CLI) | Sì, `--dangerously-skip-permissions` | Da verificare | Sì (skill, hook, subagent, plugin), config in `~/.gemini/` | Limiti per gruppo di modelli (settimanali e 5h) letti da tool esistenti | Gemini CLI non serve più account individuali dal 18 giugno 2026; Antigravity è closed-source. Dà accesso anche a modelli Claude/GPT con quota propria |

**Vincoli da rispettare nell'implementazione**

- Tutti i canali di lettura quote sono non ufficiali: ogni lettura riporta un livello di affidabilità e una data; se un canale si rompe il sistema degrada alla stima interna senza bloccare il routing.
- Headless implica permessi saltati: il flag va passato solo dentro la sandbox descritta nella sezione 9.
- Ogni provider ha un modo proprio di indicare quota esaurita (errore 429, messaggio, exit code): l'adapter lo normalizza in `quota_exhausted`.
- Autenticazione: Dispatch non gestisce credenziali. Verifica solo che il CLI sia loggato (`doctor`) e rimanda l'utente al login del CLI se non lo è.
- Le regole di billing e di uso OAuth dei provider possono cambiare: l'adapter dichiara in un campo quale pool consuma (`subscription`, `api_credit`, `unknown`) e l'utente lo vede in `status`.

**Fonti consultate.** [Help Center Anthropic: Agent SDK e piano Claude](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) · [Transizione Gemini CLI → Antigravity CLI](https://github.com/google-gemini/gemini-cli/discussions/28017) · [Claude Code: PreToolUse non scatta per Agent](https://github.com/anthropics/claude-code/issues/69545) · [Codex hooks: formato e PreToolUse con updatedInput](https://github.com/falcosecurity/prempti/blob/main/hooks/codex/README.md) · [Lettura quote Claude/Codex/Gemini da script](https://ianlpaterson.com/blog/tracking-claude-codex-gemini-quotas-from-one-script/) · [ai-limit-checker](https://pypi.org/project/ai-limit-checker/0.8.0/)

## 5. Integrazione con gli host

L'obiettivo è che l'utente installi Dispatch e lo trovi attivo nel suo client senza modificare skill, agenti o file di istruzioni. Il livello di automatismo raggiungibile dipende da cosa ogni host espone; dove l'intercettazione dura non è possibile, si usa quella morbida.

**Due livelli di integrazione**

- *Hard interception*: un hook del host intercetta lo spawn di un sub-agent o una chiamata a tool e lo reindirizza a Dispatch. L'orchestratore non deve fare nulla; la delega è garantita dalla policy.
- *Soft integration*: Dispatch si rende disponibile come sub-agent, skill o tool MCP e inietta a inizio sessione un contesto che spiega all'orchestratore quando usarlo. L'orchestratore sceglie; la policy è una raccomandazione forte, non un vincolo.

| Host | Livello al lancio | Meccanismo | Cosa tocca l'installer |
| --- | --- | --- | --- |
| Claude Code | Soft | Sub-agent `dispatch` in `.claude/agents/`, oppure tool MCP; hook `SessionStart` con `additionalContext` che descrive la policy attiva; hook `PreToolUse` su Bash per intercettare lanci manuali | `.claude/settings.json` (voce hooks e/o MCP, in append con marker), un file agent nuovo |
| Codex CLI | Hard dove possibile | `~/.codex/hooks.json` + feature flag; `PreToolUse` con `updatedInput` per riscrivere la chiamata; `SubagentStart` da verificare per lo spawn; fallback soft con una sezione marcata in AGENTS.md | `hooks.json`, `config.toml` (flag), eventualmente AGENTS.md in append |
| Antigravity CLI | Da verificare | Hook in `~/.gemini/settings.json`, skill o subagent; fallback soft | `settings.json`, un file skill nuovo |

**Requisiti comuni**

1. Gli script hook controllano all'avvio se Dispatch è installato e configurato; se no, escono senza errore e senza output (chi clona la repo senza il tool non vede nulla).
2. Ogni voce scritta nelle config del host è delimitata da marker (`# dispatch:begin` / `# dispatch:end` o equivalente JSON) e rimossa integralmente da `uninstall`.
3. L'installer rileva gli host presenti (binario nel PATH, cartella di config nella repo) e propone solo quelli; non crea cartelle di host assenti.
4. L'integrazione non altera il comportamento dei sub-agent nativi del host: se la policy decide "resta sul host", il task prosegue come se Dispatch non esistesse.
5. Un host nuovo si aggiunge con un modulo di integrazione dedicato, senza toccare il core.
6. L'host in uso viene riconosciuto a runtime (variabili d'ambiente, processo padre, config) e diventa automaticamente il provider "self" escluso dal routing.

**Caso senza host (uso da terminale o da framework esterno).** `dispatch run --task "..."` funziona anche fuori da qualsiasi client; un framework custom (script Python, LangGraph, CrewAI, Forge) lo chiama come subprocess e legge il JSON. Qui non c'è nulla da intercettare: è l'utente che integra la chiamata.

## 6. Modelli, effort e mapping

Il framework non mappa modello→modello: normalizza la richiesta in un'astrazione (`tier` × `effort`) che ogni provider risolve nella propria tabella. Così un modello nuovo si aggiunge con tre righe in un adapter, e il framework dell'utente continua a parlare di modelli reali senza sapere dell'astrazione.

**Astrazione di default** (l'utente può ridefinire i livelli, aggiungerne o rinominarli):

- `tier`: `fast` · `balanced` · `max`
- `effort`: `low` · `medium` · `high`

**Tabelle per provider.** Ogni adapter ha una tabella `tier → modello reale + parametro effort nativo` e una tabella inversa `modello reale → tier` per classificare ciò che il host ha richiesto. Entrambe sono file di configurazione versionati, sovrascrivibili dall'utente.

**Effort.** Gli effort non sono equivalenti tra provider (costo e profondità diversi). La tabella effort di ogni provider dichiara un costo relativo indicativo. Opzione `effort_shift` per provider: "quando deleghi, scala l'effort di N livelli" (es. −1 per risparmiare quota sugli esterni).

**Modello non specificato.** Quando il host lancia un sub-agent senza indicare un modello, il sub-agent erediterebbe quello della sessione. Per Dispatch "non specificato" è un valore a sé con regola configurabile:

| Valore | Comportamento | Quando ha senso |
| --- | --- | --- |
| `inherit` (default) | Legge il modello della sessione del host, lo classifica nel tier, usa lo stesso tier sull'esterno | Chi vuole lo stesso livello ovunque, senza sorprese |
| `balanced` / `fast` | Usa quel tier sull'esterno a prescindere dalla sessione | Chi usa un modello top per la conversazione ma non per i task di routine |
| `classify` (opt-in) | Stima il tier dal task (lunghezza, parole chiave, file toccati o una chiamata a un modello `fast`) | Solo dopo che la shadow mode ha mostrato stime affidabili |

Se il modello della sessione non è ricavabile, il sistema usa il valore configurato e lo annota nel log come decisione presa senza il dato.

**Mapping diretti.** L'utente può dichiarare corrispondenze esplicite `modello:effort → provider:modello:effort` che bypassano i tier. Hanno precedenza sull'astrazione.

**Preset di mapping** (file yaml copiati dall'installer, editabili):

- `mirror` — stesso tier e stesso effort su ogni provider (default)
- `economy` — stesso tier, effort −1 sui provider esterni
- `best-of-breed` — override per tipo di task (review → provider A a `max`, test → provider B a `fast`, ecc.)
- `custom` — l'utente parte da un file vuoto commentato

**Requisiti**

1. Tutto ciò che un preset imposta è visibile ed editabile nello stesso file di configurazione: nessuna logica nascosta dietro un nome.
2. `validate` segnala tier non definiti, modelli sconosciuti all'adapter, mapping contraddittori.
3. `explain` mostra per un task: modello richiesto dal host → tier classificato → provider scelto → modello ed effort risolti, con la regola che ha deciso ogni passaggio.

## 7. Routing, profili e sperimentazione

Il router riceve un task con il suo contesto e restituisce una decisione: provider, modello, effort e la catena di regole che l'ha prodotta. L'utente deve poter costruire qualsiasi strategia e confrontarne più d'una sui propri dati reali.

**Ordine di precedenza (fisso, documentato)**

1. `pin` — regole che forzano un task su un provider o sul host, a prescindere da tutto (es. tutto ciò che tocca `migrations/` resta sull'orchestratore)
2. mapping diretto esplicito (sezione 6)
3. regole del profilo attivo
4. tier/preset
5. default di sistema

**Condizioni disponibili nelle regole** (combinabili): tipo di task (test, docs, refactor, review, feature, bugfix — dichiarato dal host o dedotto da parole chiave), percorsi di file coinvolti, tier/effort richiesti, quota residua stimata per provider, affidabilità del dato di quota, fascia oraria, dimensione stimata del task, esito dei tentativi precedenti nella stessa sessione.

**Azioni possibili**: scegli provider X; resta sul host; prova X poi Y poi host (fallback ordinato); esegui su due provider e restituisci entrambi (seconda opinione); rifiuta con motivo.

**Strategie base fornite come profili** (file in `.dispatch/profiles/`, editabili):

| Profilo | Cosa ottimizza | Comportamento |
| --- | --- | --- |
| `balance` | Arrivare a fine settimana con tutti i provider utilizzabili | Delega al provider con più quota residua in proporzione; soglie di protezione per ciascuno |
| `preserve` | Tenere il host sempre disponibile per il lavoro interattivo | Delega all'esterno tutto ciò che è delegabile; il host fa solo orchestrazione e task pinnati |
| `specialize` | Qualità per tipo di task | Tabella task-type → provider preferito, con fallback per quota |
| `off` | Nessuna delega | Tutto sul host; utile per confronto e per debug |

**Strumenti di sperimentazione**

- `dispatch use <profilo>` cambia profilo senza toccare il resto; l'utente può creare profili propri e condividerli.
- `dispatch explain --task "..."` esegue il router a secco e mostra la decisione con la catena di regole, lo stato quote usato e cosa sarebbe cambiato con gli altri profili.
- **Shadow mode**: per ogni task eseguito, il log registra anche la decisione che avrebbero preso gli altri profili configurati. `status --compare` mostra, su una finestra di tempo, per ciascun profilo: quota che avrebbe consumato per provider, task che sarebbero andati in fallback, costo relativo stimato.
- **Dry run globale**: `run --dry-run` restituisce la decisione senza eseguire nulla.

**Soglie di quota.** Per provider: `soft_limit` (sotto questa % residua il router lo evita se c'è alternativa), `hard_limit` (sotto questa non lo usa mai), `reserve_for_host` (quota che il provider host tiene per sé quando è esso stesso un target possibile in configurazioni multi-account).

**Requisiti**

1. Nessuna decisione senza log: provider scelto, regola vincente, stato quote al momento, affidabilità del dato.
2. Una regola che non compila o contraddice un'altra viene segnalata da `validate` prima dell'uso, non a runtime.
3. Il router è deterministico a parità di input e stato: stessa configurazione, stesso task, stesse quote → stessa decisione.

## 8. Quote e contabilità

Il modulo quote risponde a una sola domanda: quanto posso ancora chiedere a ciascun provider, e quanto mi fido del numero. Deve funzionare anche quando nessun canale di lettura è disponibile.

**Tre fonti, in ordine di preferenza**

1. *Lettura reale* — canali non ufficiali per provider (endpoint OAuth di Claude, JSON-RPC di Codex, file o endpoint di Antigravity). Restituiscono % usata e orario di reset per finestra (5h, 7 giorni, mensile).
2. *Stima interna* — Dispatch registra ogni esecuzione delegata (provider, modello, durata, token se riportati) e la proietta sulle finestre dichiarate dal piano dell'utente. Serve da fallback e da verifica incrociata.
3. *Segnale di esaurimento* — un `quota_exhausted` restituito dall'adapter aggiorna immediatamente lo stato del provider a "non disponibile fino al reset" (noto o stimato).

**Modello dati per provider**: finestre attive (tipo, % usata, reset, fonte, timestamp della lettura, affidabilità `real` / `estimated` / `stale` / `unknown`), pool consumato (`subscription` / `api_credit` / `unknown`), ultimo errore di quota.

**Comportamento**

- Le letture reali avvengono con cache e frequenza configurabile (default: prima di ogni `run` se la cache è più vecchia di N minuti; `watch` può fare polling più fitto vicino ai limiti).
- Se un canale di lettura fallisce o restituisce dati incoerenti (es. sempre 100% residuo), il modulo lo marca `stale` e passa alla stima; `doctor` lo segnala.
- Il piano dichiarato nel setup (Pro, Max 5x, Plus, Pro OpenAI, AI Pro, AI Ultra…) alimenta la stima; l'utente può correggere manualmente la percentuale corrente (`status --set claude 40%`) quando sa più del tool.
- Più account dello stesso provider sono quote separate.
- La sessione interattiva del host consuma quota che Dispatch non vede: il modulo tratta il host come provider con dati "solo lettura reale o unknown", mai stimati dalle proprie esecuzioni.

**Cosa vede l'utente** (`status`): una riga per provider con % residua per finestra, reset, fonte del dato e un indicatore di affidabilità; con `--history` l'andamento degli ultimi giorni; con `--compare` il confronto tra profili (shadow mode).

**Requisiti**

1. I lettori di quota sono moduli separati per provider, sostituibili senza toccare il router; ognuno dichiara la propria versione e il canale usato.
2. Nessuna credenziale viene copiata o persistita da Dispatch: i lettori usano i file di credenziali dei CLI in sola lettura, sul posto.
3. Il routing non si blocca mai per assenza di dati di quota: degrada a stima o a round-robin con fallback su `quota_exhausted`.
4. Lo stato è persistito in `~/.dispatch/state/` (globale, perché le quote sono dell'account e non della repo).

## 9. Sicurezza ed esecuzione isolata

Gli agenti esterni girano in headless, quindi senza conferme interattive. La sicurezza non può venire dai prompt del CLI: viene dall'isolamento e dalla review dell'orchestratore.

**Livelli di autonomia** (scelti nel setup, sovrascrivibili per provider e per tipo di task):

| Livello | Cosa può fare l'esterno | Come torna il risultato |
| --- | --- | --- |
| `read-only` | Leggere la repo, ragionare, produrre testo (analisi, review, piani) | Solo testo strutturato, nessuna patch |
| `worktree` (default) | Modificare file e lanciare comandi dentro un worktree git dedicato al task | Patch git + log; l'orchestratore decide se applicarla |
| `direct` (opt-in) | Scrivere nella working copy dell'utente | Modifiche già applicate; uso sconsigliato, richiede conferma esplicita all'attivazione |

**Regole della sandbox**

1. Un worktree per task, creato dal branch corrente, distrutto a fine task (o conservato per debug se configurato).
2. Timeout per task (default configurabile); allo scadere l'esecuzione viene terminata e l'esito è `timeout` con quanto prodotto fino a quel momento.
3. Scope: l'adapter può limitare i percorsi scrivibili (allow-list) e i comandi lanciabili; i file di configurazione di Dispatch, le credenziali dei CLI e `.git` interno non sono mai scrivibili dall'esterno.
4. Variabili d'ambiente: l'esterno riceve un ambiente minimo; nessun segreto del host viene propagato se non elencato esplicitamente.
5. Rete: nessuna restrizione imposta da Dispatch (i CLI ne hanno bisogno), ma documentato chiaramente.
6. La patch restituita viene verificata: deve applicarsi pulita sul branch da cui è nato il worktree; altrimenti esito `failed` con il conflitto allegato.

**Protezione delle istruzioni.** Il contenuto letto dall'esterno (file, pagine, output di comandi) è dato, non istruzione. Il riassunto che l'esterno restituisce all'orchestratore è marcato come proveniente da un agente esterno, così l'orchestratore lo tratta con la cautela dovuta.

**Parallelismo.** Più task esterni possono girare in parallelo, ciascuno nel proprio worktree; un limite configurabile di esecuzioni concorrenti per provider evita di saturare le quote in pochi minuti.

**Cosa non fa Dispatch**: non applica patch da solo, non fa commit, non apre PR. Queste azioni restano all'orchestratore o all'utente.

## 10. Setup, comandi CLI e file

Il setup chiede solo ciò che il tool non può scoprire da solo e che varia da persona a persona; tutto il resto è rilevato o messo a default. Quattro domande, poi si lavora.

**Installazione.** Un comando (package manager o script) che mette `dispatch` nel PATH. Nessuna dipendenza da un host specifico.

**`dispatch install` (nella repo)**

1. Rileva: CLI presenti e loggati, host presenti nella repo, worktree git.
2. Chiede, se non già in `~/.dispatch/`: account principale; piano di ogni provider; strategia iniziale (`balance` / `preserve` / `specialize`); livello di autonomia degli esterni.
3. Scrive `~/.dispatch/config.yaml` (globale) se mancante e `.dispatch/` nella repo con `config.yaml` commentato, i profili e i preset di mapping.
4. Integra gli host rilevati (sezione 5), mostrando prima cosa scriverà e dove, e chiedendo conferma.
5. Esegue `doctor` e mostra `status`.

Flag `--non-interactive` con tutti i valori da riga di comando o da file, per CI e script.

**Comandi**

| Comando | Scopo |
| --- | --- |
| `run --task "..." [--provider auto\|claude\|codex\|antigravity] [--tier] [--effort] [--dry-run] [--json]` | Esegue (o simula) un task esterno; è ciò che hook e framework chiamano |
| `install` / `uninstall` | Integra o rimuove completamente, host inclusi |
| `doctor` | Verifica CLI, login, hook, lettori quota, con un task di prova minimo per provider |
| `status [--history] [--compare] [--set <provider> <pct>]` | Quote, affidabilità, confronto profili, correzione manuale |
| `watch` | Eventi in tempo reale delle esecuzioni esterne in corso |
| `use <profilo>` / `profiles` | Cambia o elenca i profili di routing |
| `explain --task "..."` | Decisione a secco con la catena di regole |
| `validate` | Coerenza della configurazione |
| `providers` | Provider rilevati, pool consumato, versione adapter |
| `logs [--task <id>]` | Log delle esecuzioni |

**File aggiunti**

```markdown
~/.dispatch/                 # globale, mai in git
  config.yaml                 # account, piani, autonomia, lettori quota
  state/                      # quote, contabilità, log

<repo>/.dispatch/            # per repo, committabile
  config.yaml                 # policy, soglie, pin, mapping, unspecified_model
  profiles/*.yaml             # strategie di routing
  mappings/*.yaml             # preset tier/effort per provider
  hooks/                      # script chiamati dagli host
  state/                      # gitignored: log locali, worktree
```

**File degli host toccati** (solo se l'host è presente, sempre in append con marker, rimossi da `uninstall`): `.claude/settings.json` e `.claude/agents/dispatch.md`; `~/.codex/hooks.json`, `~/.codex/config.toml` ed eventualmente `AGENTS.md`; `~/.gemini/settings.json` ed eventuale skill.

**File mai toccati**: CLAUDE.md, skill esistenti, sub-agent esistenti, codice del progetto, `.gitignore` (salvo aggiungere `.dispatch/state/` con conferma).

**Config globale vs per repo.** Account, piani e quote sono dell'utente e stanno in `~/.dispatch/`; policy e profili sono del progetto e stanno nella repo, così un team può condividere le regole senza condividere gli account. Un valore per repo ha precedenza su quello globale per le chiavi che esistono in entrambi.

## 11. Use case dettagliati

Ogni caso descrive lo scenario, il comportamento atteso e cosa deve essere verificabile. Sono anche la base per i test di accettazione.

**UC1 — Primo setup su repo esistente.** Sviluppatore con Claude Code come client, account Codex e Antigravity loggati. Lancia `dispatch install`: il tool rileva i tre CLI e `.claude/` nella repo, fa le quattro domande, scrive i file, aggiunge il sub-agent e il hook `SessionStart` in `.claude/settings.json`, esegue `doctor` (tre task di prova riusciti) e mostra `status` con le tre quote. Verifica: nessun file preesistente modificato oltre a `settings.json` in append; `git diff` mostra solo `.dispatch/` e la voce marcata.

**UC2 — Delega automatica da Claude Code (soft).** Sessione Claude Code in Opus. L'utente chiede "scrivi i test per il modulo auth". Il contesto iniettato dice che i task di tipo test vanno delegati con profilo `preserve`. L'orchestratore chiama il sub-agent `dispatch`, che esegue `run`; il router sceglie Codex (quota 70% residua, tier `inherit` → `max`), gira in worktree, restituisce patch + riassunto. L'orchestratore legge il riassunto, applica la patch, lancia i test, riporta all'utente. Verifica: log con regola vincente; `status` mostra il consumo stimato su Codex; nessuna chiamata a `claude -p`.

**UC3 — Stessa cosa da Codex (hard).** Client Codex, host = OpenAI. Il hook `PreToolUse` intercetta lo spawn e, per policy, riscrive la chiamata verso `dispatch run --provider claude`. Verifica: il sub-agent nativo di Codex non parte; il risultato arriva come tool result.

**UC4 — Fallback per quota.** Profilo `balance`, Codex sotto `hard_limit`. Un task delegabile viene instradato ad Antigravity; se anche Antigravity restituisce `quota_exhausted`, il task torna all'orchestratore con un messaggio che spiega il motivo. Verifica: tre decisioni loggate, l'utente vede in `status` entrambi i provider marcati non disponibili con reset stimato.

**UC5 — Task pinnato.** Regola `pin`: percorsi `db/migrations/**` restano sul host. Qualunque profilo attivo, un task che tocca quei file non viene mai delegato. Verifica: `explain` mostra la regola pin come vincente.

**UC6 — Modello non specificato.** L'orchestratore lancia un sub-agent senza modello; `unspecified_model: balanced`. L'esterno riceve tier `balanced` anche se la sessione è in Opus. Con `inherit` riceverebbe `max`. Verifica: `explain` mostra entrambi i percorsi.

**UC7 — Seconda opinione.** Regola: i task di tipo review vanno eseguiti su due provider. L'orchestratore riceve due riassunti marcati con il provider di origine e li confronta. Verifica: due worktree, due log, nessuna patch applicata automaticamente.

**UC8 — Sperimentazione tra profili.** L'utente lavora una settimana con `balance` e shadow mode attiva. `status --compare` mostra che `preserve` avrebbe consumato il 30% in meno sul host e avuto due fallback in più. L'utente passa a `preserve` con `use preserve`. Verifica: il confronto usa solo dati di decisioni reali registrate, mai simulazioni.

**UC9 — Collaboratore senza Dispatch.** Un collega clona la repo, apre Claude Code: il hook in `settings.json` punta a uno script che rileva l'assenza del tool ed esce silenzioso. Verifica: nessun errore, nessun messaggio, comportamento identico a una repo senza Dispatch.

**UC10 — Uso senza host.** Uno script Python chiama `dispatch run --task "..." --json` e legge il risultato. Verifica: funziona senza nessun CLI host in esecuzione, host "self" = nessuno, tutti i provider disponibili.

**UC11 — Canale quote rotto.** L'endpoint di lettura quote di un provider cambia formato. `doctor` lo segnala; `status` mostra `stale` con l'ultima lettura buona; il router usa la stima interna. Verifica: nessun crash, nessun blocco del routing.

**UC12 — Secondo account dello stesso provider / pool API.** L'utente aggiunge un secondo account Claude (o il pool crediti API di Max) come provider esterno opt-in. Dal client Claude Code, i task delegabili possono andare a quell'account. Verifica: l'invariante "il host non invoca se stesso" vale per l'account della sessione, non per il secondo.

**UC13 — Timeout e patch non applicabile.** Un task esterno supera il timeout: l'orchestratore riceve esito `timeout` con la patch parziale e il log. Un altro restituisce una patch che non si applica: esito `failed` con il conflitto. Verifica: i worktree sono conservati solo se configurato; nessuna modifica alla working copy.

**UC14 — Disinstallazione.** `dispatch uninstall` rimuove le voci marcate da tutte le config host, il sub-agent/skill aggiunti e la cartella `.dispatch/`, chiedendo se conservare `~/.dispatch/`. Verifica: `git diff` pulito rispetto allo stato pre-install.

## 12. Fuori scope, rischi aperti e criteri di accettazione

**Fuori scope nella prima versione**

- Interfaccia grafica o web: solo CLI e output JSON.
- Routing semantico con un modello (`classify`) attivo di default.
- Gestione delle credenziali o login dei provider.
- Host diversi dai tre indicati (l'architettura li prevede, non si implementano).
- Applicazione automatica delle patch, commit o PR da parte di Dispatch.
- Merge o riconciliazione automatica tra risultati di provider diversi (UC7 restituisce entrambi, non li fonde).

**Rischi aperti** (da verificare nella fase di piano, prima dello sviluppo)

| Rischio | Impatto | Mitigazione attesa |
| --- | --- | --- |
| I canali di lettura quote cambiano o spariscono | Routing meno preciso | Lettori isolati e versionati; stima interna; `stale` visibile |
| Claude Code non espone un'intercettazione dura dei sub-agent | Delega non garantita dal client Claude | Soft integration ben fatta; monitorare le release per `PreToolUse` su Agent |
| Codex: `SubagentStart` potrebbe non permettere il redirect | Hard interception parziale | Verificare in `doctor`; fallback a `PreToolUse` su chiamate tool o a soft |
| Antigravity headless: streaming eventi e hook non ancora verificati | Adapter meno ricco | Prototipo early; livello `read-only` finché non è stabile |
| Cambi nelle regole di billing/OAuth dei provider | Un pool si svuota inaspettatamente o un uso diventa non consentito | Campo `pool` esposto in `status`; documentazione chiara dei termini; nessuna elusione tecnica |
| Prompt injection da contenuti letti dall'esterno | Azioni indesiderate nella sandbox | Isolamento, allow-list, riassunto marcato come esterno |

**Criteri di accettazione della prima versione**

1. Tutti gli use case UC1–UC14 superati con test automatici dove possibile (adapter finti per i CLI) e manuali documentati dove serve un account reale.
2. `install` + `uninstall` lasciano la repo identica allo stato iniziale (diff vuoto).
3. Ogni decisione di routing è riproducibile con `explain` e ha un log.
4. Con tutti i lettori di quota disabilitati, il sistema continua a delegare e a gestire `quota_exhausted`.
5. Un collaboratore senza Dispatch non percepisce la sua presenza nella repo.
6. Documentazione in inglese: README con setup in cinque minuti, riferimento completo della configurazione, guida per scrivere un nuovo adapter e un nuovo modulo di integrazione host.
7. Nessuna credenziale copiata, loggata o trasmessa da Dispatch.
