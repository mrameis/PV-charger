# Keba / go-eCharger PV-Überschussladen

Home-Assistant-App (Node.js/TypeScript) mit eigenem Dashboard, die eine
**Keba KeContact** (Modbus TCP) oder einen **go-eCharger** (lokale HTTP API)
so regelt, dass möglichst nur PV-Überschuss zum Laden verwendet wird.

**Ab Version 2.1: Geräteverwaltung statt fester Felder.** Im Reiter „Einstellungen"
gibt es vier Kategorien - **Ladestation**, **Netzzähler**, **Batterie**,
**Solar-Wechselrichter** - jeweils mit eigener Geräteliste. Pro Kategorie per
„+ Gerät hinzufügen" beliebig viele Geräte anlegen (Dropdown zeigt die für diese
Kategorie sinnvollen Typen). Bei Ladestation/Netzzähler ist immer genau ein Gerät
„aktiv" (das steuert die Regelung), bei Batterie/Solar werden alle aktivierten
Geräte gemeinsam angezeigt bzw. zur PV-Summe addiert.

**Wichtig zu Shelly:** ein Shelly 3EM kann sowohl als **Netzzähler** (Bezug/
Einspeisung am Hausanschluss, mit Vorzeichen) als auch als **Solar-Wechselrichter**
-Messung (reine Erzeugungsmessung eines einzelnen Wechselrichters, ohne Vorzeichen)
eingesetzt werden - je nachdem, in welcher Kategorie du ihn hinzufügst. Es kann
z. B. ein Shelly als Netzzähler UND ein zweiter Shelly unter Solar-Wechselrichter
(an einem einzelnen WR montiert) parallel laufen.

## Installation über dein GitHub-Repository

Repo-Struktur (unverändert seit dem Repository.yaml-Fix):

```
PV-charger/                    <- Repo-Root
├── repository.yaml
└── keba_pv_charger/
    ├── config.yaml
    ├── Dockerfile
    ├── src/
    ├── public/
    └── ...
```

1. Repo public stellen (falls noch nicht geschehen).
2. Diesen Ordnerinhalt pushen, Struktur wie oben beibehalten.
3. In Home Assistant: **Settings → Apps → App-Store → ⋮ → Repositories** →
   `https://github.com/mrameis/PV-charger` → Hinzufügen.
4. **„Keba/go-eCharger PV-Überschussladen"** installieren, **Starten**.
5. Im Tab **„Info"**: „In Sidebar anzeigen" aktivieren.
6. Dashboard öffnen → Reiter **„Einstellungen"** → Wallbox-Typ wählen, IPs
   eintragen, jeweils **Speichern**. Wirkt sofort, kein Neustart nötig.

### Migration von Version 1.x (Konfiguration über HA-Options-Tab)

Falls du vorher schon `keba_host`/`shelly3em_host`/etc. im HA-Konfigurationstab
gesetzt hattest: diese Werte werden beim ersten Start automatisch als
Ladestation-/Netzzähler-/PV-Geräte in die neue Geräteverwaltung übernommen
(einmalige Migration). Der HA-Konfigurationstab selbst hat danach nur noch
das Feld `log_level` - alles andere passiert im Dashboard unter „Einstellungen".

### Alternative: lokale App ohne GitHub / eigenständig via docker-compose

Wie bisher: `keba_pv_charger/` nach `/addons/local/keba_pv_charger/` kopieren
(lokale App, kein Git nötig), oder `docker-compose.yml`/`.env.example` für den
Betrieb außerhalb von Home Assistant nutzen (kein Ingress, eigenes Dashboard
auf Port 8080).

Falls Netzwerkzugriffe auf deine Geräte aus der App heraus fehlschlagen: in
`config.yaml` `host_network: true` ergänzen und die App neu bauen.

## Architekturentscheidung: eine Wahrheit für den Regelkreis

Der Regelkreis (Ladestrom rauf/runter, Phasenumschaltung) basiert **ausschließlich**
auf der Netzleistung deines **Shelly 3EM** am Hausanschluss (positiv = Bezug,
negativ = Einspeisung/Überschuss) - wie bei evcc/openWB. Fronius, StecaGrid und
Victron sind **optional** und nur für die Anzeige, nicht für die Regelung.

## Unterstützte Wallboxen

| Typ | Protokoll | Anmerkung |
|---|---|---|
| **Keba KeContact** (P30c u. a.) | Modbus TCP, Port 502, Unit-ID 255 | DIP-Schalter DSW1.3 = ON nötig, siehe unten |
| **go-eCharger** (Home/Home+) | Lokale HTTP API v2 | In der go-e App unter „Internet → Erweiterte Einstellungen" aktivieren |

Der Wallbox-Typ ist im Reiter „Einstellungen" umschaltbar - beim Speichern wird
die Verbindung zur neuen Wallbox sofort aufgebaut, ohne App-Neustart.

### Keba: Vor der Inbetriebnahme

1. DIP-Schalter **DSW1.3 = ON** an der Wallbox (aktiviert Modbus TCP; Modbus
   und UDP-Schnittstelle sind exklusiv - altes UDP-basiertes Modul vorher deaktivieren).
2. Port 502 muss vom Docker-Host aus erreichbar sein.
3. Automatische Phasenumschaltung braucht das **S10-Zubehör**. Ohne das:
   Phasenmodus in den Einstellungen auf „Fest 1-phasig"/„Fest 3-phasig" stellen.

### go-eCharger: Vor der Inbetriebnahme

1. In der go-e App: **Internet → Erweiterte Einstellungen → Lokale HTTP API v2**
   aktivieren.
2. Für die automatische Phasenumschaltung wird `psm` direkt auf 1-phasig/3-phasig
   gesetzt (nicht der Auto-Modus der Wallbox selbst, um Konflikte mit unserer
   eigenen PV-Logik zu vermeiden). Manche Fahrzeuge brauchen laut Community-
   Berichten eine kurze Standby-Phase beim Umschalten - bitte einmal manuell
   beobachten, bevor du dich auf „Automatisch" verlässt.

## ⚠️ Wichtig: Register-/API-Verifizierung vor Produktivbetrieb

Die Keba-Modbus-Register (`src/wallbox/keba.ts`) und die go-eCharger-API-Felder
(`src/wallbox/goecharger.ts`) stammen aus den jeweiligen offiziellen Dokus bzw.
mehrfach übereinstimmenden Community-Quellen, können aber je nach Firmware
leicht abweichen. Bitte **vor dem ersten unbeaufsichtigten Lauf**:

1. Dashboard öffnen, mit angestecktem (aber idealerweise noch nicht ladendem)
   Auto Status/Strom/Phasen gegen das Wallbox-Display bzw. die Hersteller-App
   gegenchecken.
2. Modus zunächst auf **„Aus"** lassen und nur beobachten.
3. Danach kurz **„Schnell"** testen (fixer Strom, keine Überschusslogik) und
   prüfen, ob der am Fahrzeug ankommende Strom passt.
4. Erst danach „Min + PV" bzw. „Nur PV" aktivieren.
5. Automatische Phasenumschaltung einmal manuell beobachten - falls sie nicht
   zuverlässig greift: Phasenmodus in den Einstellungen fixieren.

## Fahrzeugprofile

Im Reiter „Einstellungen" → „Fahrzeuge" kannst du beliebig viele Fahrzeuge mit
eigener Mindest-/Maximalladung anlegen. Im Dashboard-Reiter kannst du das aktuell
angesteckte Fahrzeug per Klick aktivieren ("Standard" = die allgemeinen
Regelparameter aus den Einstellungen). Das aktive Fahrzeug überschreibt nur
Mindest-/Maximalstrom, alles andere (Modus, Phasenlogik) bleibt gleich.

## Lademodi im Dashboard

- **Aus** – Wallbox gesperrt, keine Ladung.
- **Nur PV** – lädt ausschließlich mit Überschuss, pausiert wenn nicht genug
  Überschuss für den (fahrzeugspezifischen) Mindeststrom vorhanden ist.
- **Min + PV** – garantiert den Mindeststrom, sobald ein Auto angesteckt ist,
  nutzt darüber hinaus vorhandenen Überschuss.
- **Schnell** – lädt mit dem (fahrzeugspezifischen) Maximalstrom, ignoriert PV.

## API

- `GET /api/status` – aktueller Snapshot (auch über WebSocket `/ws` live, `{type:"snapshot", data:...}`)
- `GET /api/history?hours=24` – Verlaufsdaten für Charts
- `GET /api/settings` / `PUT /api/settings` – Regelparameter (Phasenmodus, Ströme, ...)
- `POST /api/mode` – `{ "mode": "off" | "pv_only" | "min_plus_pv" | "fast" }`
- `GET /api/devices?category=wallbox|grid_meter|battery|pv_source` – Geräteliste
- `POST /api/devices`, `PUT/DELETE /api/devices/:id`, `POST /api/devices/:id/activate`
- `GET/POST /api/vehicles`, `PUT/DELETE /api/vehicles/:id`
- `POST /api/vehicles/:id/activate`, `POST /api/vehicles/deactivate`

## Bekannte Stolpersteine

- **Keba-Failsafe:** Watchdog - ohne regelmäßige Modbus-Kommandos fällt die
  Wallbox auf einen Sicherheitswert zurück. Der Regelkreis schreibt daher bei
  jedem Tick (Standard 10 s) erneut den Sollstrom.
- **go-eCharger-Pause:** anders als Keba (0 A anbieten) kennt go-e kein „0A" -
  Pausieren geschieht über `frc=1` (Off), Fortsetzen über `frc=0`.
- **StecaGrid-XML-Pfad:** Standard ist `/measurements.xml` (verifiziert),
  bei abweichender Firmware in den Einstellungen unter „Zusätzliche PV-Quellen"
  einen anderen Pfad eintragen.
- **Victron-Register:** mit mittlerer Sicherheit übernommen, siehe Kommentar in
  `src/energy/victron.ts`. Nur für die Anzeige relevant, nicht für die Regelung.
