# byvanie-monitor

Dvakrát denne prejde slovenské realitné portály, vyberie nové prenájmy, ktoré sedia
na kritériá, a pošle ich do Slacku. Beží na GitHub Actions, nepotrebuje server.

## Ako to funguje

```
src/sources/*  ->  src/filter.ts  ->  dedup (data/seen.json)  ->  src/slack.ts
```

`src/index.ts` volá zdroje paralelne (každý v try/catch, takže jeden rozbitý portál
nezhodí celý beh), výsledok prefiltruje, zahodí už videné inzeráty a zvyšok pošle
do Slacku. Odoslané id sa zapíšu do `data/seen.json`, ktorý workflow commitne späť
do repa – to je celá "databáza". Každý beh navyše zapíše `reports/YYYY-MM-DD-HHmm.md`
(UTC) s počtami za jednotlivé zdroje a zoznamom tých, ktoré zlyhali; workflow ho
commitne spolu so seen.json.

## Stav

Kostra projektu. `src/config.ts`, `src/types.ts`, `src/state.ts` a `src/index.ts` sú
hotové; `src/filter.ts`, `src/slack.ts` a moduly v `src/sources/` sú zatiaľ stuby,
ktoré hádžu `not implemented`.

## Nastavenie

1. `npm install`
2. V Slacku vyrob incoming webhook a URL ulož do repa ako secret **`SLACK_WEBHOOK_URL`**
   (Settings → Secrets and variables → Actions → New repository secret).
3. Settings → Actions → General → Workflow permissions → **Read and write permissions**,
   aby mohol workflow commitnúť `data/seen.json`.

## Spustenie

```bash
npm run run          # ostrý beh, potrebuje SLACK_WEBHOOK_URL
npm run test:local   # DRY_RUN=1 – vypíše nálezy do konzoly, nič neposiela ani nezapisuje
npm run typecheck    # tsc --noEmit
```

Workflow beží podľa cronu `0 6 * * *` a `0 17 * * *` (UTC) a dá sa spustiť aj ručne
cez **Actions → monitor → Run workflow**.

## Kritériá

Všetko sa ladí v `src/config.ts` (`CRITERIA`): min. 3 izby, max. 1200 € vrátane
energií, min. 60 m², celý Bratislavský kraj, plus kladné a záporné kľúčové slová.
Keď inzerát uvádza iba nájom bez energií, doráta sa odhad 150 €.
