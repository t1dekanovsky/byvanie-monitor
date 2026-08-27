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
(UTC) s počtami za jednotlivé zdroje, zoznamom tých, ktoré zlyhali, a sekciami
**Odoslané** a **Potlačené** – tam je pri každom inzeráte skóre, cena, plocha,
lokalita a odkaz, takže sa nič nemusí dohľadávať v histórii Slacku. Report má strop
119 riadkov; keď sa zoznamy nezmestia, nechá tie s najvyšším skóre a dopíše, koľko
vynechal. Workflow ho commitne spolu so seen.json.

## Zdroje

`zoznamrealit.sk`, `reality.sk`, `nehnutelnosti.sk` a `reality.bazos.sk`. Prvé tri sú
realitné portály, Bazoš je bazár s inzerátmi priamo od majiteľov – práve preto tam býva
ponuka bez provízie.

### Bazoš a robots.txt

Na Bazoši sťahujeme výpisy `reality.bazos.sk/prenajmu/{byt,dom}/` s parametrami
`hlokalita` (PSČ), `humkreis` (okolie v km) a `cenado` (strop ceny), teda cesty, ktoré
má portál v `robots.txt` zakázané. Je to vedomé rozhodnutie a dôvod je paradoxný:
povolené sú len kategórie bez filtra, tie však majú vyše 6 000 prenájmov za celé
Slovensko v poradí, ktoré nie je podľa dátumu, takže pokryť Bratislavský kraj by
znamenalo stiahnuť zhruba 320 strán namiesto 57. Filtrovaný dopyt je pre ich server
rádovo menšia záťaž než jediná legálna alternatíva. Aby to tak aj zostalo, Bazoš má
vlastný režim: predstavuje sa hlavičkou `User-Agent`, v ktorej je názov nástroja, účel
(osobné hľadanie bytu), frekvencia a kontaktný e-mail; všetky jeho požiadavky idú cez
jednu frontu s rozostupom 700 ms (necelé dve za sekundu); na `HTTP 429` a `503` čaká
30 s, potom 60 s a po treťom odmietnutí zdroj pre daný beh zavrie; a beží najviac
**dvakrát za kalendárny deň (UTC)** bez ohľadu na to, čo ho spustí – plán, ručné
spustenie aj backfill. Počítadlo je v `data/run-quota.json`. Keď je strop vyčerpaný,
Bazoš sa preskočí, ostatné tri zdroje bežia ďalej a v reporte behu je pri ňom
`PRESKOČENÝ`. Ide o osobné použitie pre jednu domácnosť, nie o komerčný zber dát.

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

Pri ručnom spustení je k dispozícii prepínač **backfill**. Zapnutý nastaví behu
`BACKFILL=1`, čím sa vypne strop prvého behu (`FIRST_RUN_LIMIT` = 15) a do Slacku
odíde všetko nové bez ohľadu na počet. Je to jednorazová poistka na dobehnutie
inzerátov, ktoré prvý beh označil ako videné bez toho, aby ich poslal – plánované
behy ju nikdy nenastavujú.

## Kritériá

Všetko sa ladí v `src/config.ts` (`CRITERIA`): min. 3 izby, max. 1200 € vrátane
energií, min. 60 m², celý Bratislavský kraj, plus kladné a záporné kľúčové slová.
Keď inzerát uvádza iba nájom bez energií, doráta sa odhad 150 €.
