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
4. Falls du die Phasenumschaltung früher per UDP-Kommando `x2src` manuell freigeschaltet
   hattest: das ist ab dieser Version nicht mehr nötig. Register 5050 (die Modbus-
   Entsprechung von `x2src`) wird von der App vor jedem Umschaltversuch selbst auf
   „3 = Modbus TCP" gesetzt. Ein früher manuell gesetzter anderer Wert (z. B. `x2src 4`
   für UDP) wurde dadurch überschrieben, was der Grund war, warum die Umschaltung nach
   Einrichtung dieser App aufgehört hatte zu funktionieren.

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
6. **Fix ab dieser Version:** die App synchronisiert ihre interne Annahme über die
   aktive Phasenzahl jetzt bei jedem Tick mit dem tatsächlich von der Wallbox
   gemeldeten Status (Keba-Register 1552). Vorher konnte die interne Annahme von
   der Realität abweichen (z. B. nach einem Neustart), wodurch die Umschaltung nur
   in eine Richtung (1→3) funktionierte, aber nicht zurück. Das Dashboard-Feld
   „Phasen" zeigt jetzt den tatsächlich gemeldeten Wert, nicht mehr nur die interne
   Regel-Annahme.
7. **Neue Diagnosezeile:** unter dem Phasen-Feld zeigt das Dashboard jetzt, wen die
   Wallbox aktuell als Quelle für die Phasenumschaltung führt (Register 1550, sollte
   „Modbus TCP" sein - entspricht dem UDP-Kommando `x2src 3`). Steht dort etwas
   anderes, wird die Zeile rot markiert - das ist der zuverlässigste Weg zu erkennen,
   ob unser Umschaltbefehl überhaupt ankommt.
8. **Falls Umschaltung/Anzeige trotzdem nicht stimmen:** manche Modbus-Implementierungen
   zählen Registeradressen ab 1 statt ab 0 (im offiziellen KEBA Modbus-Handbuch
   ausdrücklich als projektabhängig vermerkt). In den Ladestation-Einstellungen gibt
   es dafür ein Feld „Register-Offset" (Standard 0) - probier `1` oder `-1`, falls die
   Diagnosezeile dauerhaft eine falsche Quelle zeigt. Zusätzlich lohnt sich ein Blick
   auf DIP-Schalter DSW1.2 an der Wallbox: manche Quellen berichten, dass X2 je nach
   dessen Stellung als Phasenumschalt-Kontakt oder als reiner Ladestatus-Kontakt
   fungiert - das ist reine Hardware-Konfiguration, die Software kann das nicht sehen.

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

## Solar-Wechselrichter: unterstützte Shelly-Modelle

Sowohl **Shelly 3EM/Pro 3EM** (3-phasig) als auch **Shelly 1PM/Plus 1PM/Pro 1PM**
(Einzelkanal) können als PV-Quelle hinzugefügt werden - je nachdem, welches Gerät
an deinem Wechselrichter hängt. Bei „Netzzähler" steht dagegen nur die 3EM-Variante
zur Wahl (Einzelkanal-Shellys eignen sich nicht als Hausanschluss-Zähler).

## Victron: Batterie zeigt jetzt auch die Solarladung

Ein unter „Batterie" hinzugefügtes Victron-Gerät zeigt neben Ladezustand (SOC) und
Batterieleistung jetzt auch die aktuelle Ladeleistung eines angeschlossenen
**Solar-MPPT-Ladereglers** (DC-gekoppelt) an - ohne dass du dasselbe Gerät zusätzlich
unter „Solar-Wechselrichter" anlegen musst. Willst du diese Solarleistung zusätzlich
in die PV-Gesamtsumme (und damit in die Überschussregelung) einrechnen lassen, füge
Victron zusätzlich unter „Solar-Wechselrichter" hinzu (dort werden DC- und
AC-gekoppelte PV-Leistung addiert).

## Ladebilanz: geladene Menge & Solaranteil

Das Dashboard zeigt jetzt „Heute geladen" und „Gesamt geladen" jeweils mit
Solaranteil in kWh und Prozent. Berechnung nach der Standard-Selbstverbrauchs-
Heuristik (wie bei evcc/openWB): Anteil der Ladeleistung, der nicht als Netzbezug
anfällt, gilt als Solar - bei Netzeinspeisung trotz Ladens zählt der komplette
Ladevorgang als 100% Solar. Das ist eine Näherung (keine physikalische Zuordnung
einzelner Wattstunden), aber der in der Praxis übliche Ansatz. Werte werden pro
Regel-Tick aufintegriert und in `/data` gespeichert (übersteht Neustarts).

## Manuelle Ladeleistung

Im Modus **„Manuell"** (5. Button neben Aus/Nur PV/Min+PV/Schnell) lässt sich die
Zielladeleistung per Regler frei zwischen **1,4 kW und 11 kW** einstellen (entspricht
6 A einphasig bis 16 A dreiphasig bei 230 V). Die PV-Überschusslogik ist in diesem
Modus deaktiviert - es wird konstant die eingestellte Leistung gehalten (die normale
automatische Phasenumschaltung inkl. Hysterese greift aber weiterhin, falls
`charge_phases_mode` auf „Automatisch" steht). Den Regler bewegen wechselt automatisch
in den manuellen Modus.

## Ladehistorie

Eigener Reiter „Ladehistorie" mit Tagesbalken (Solar- vs. Netzanteil) und einer
Tagesübersicht-Tabelle der letzten 30 Tage. Berechnet aus den ohnehin gespeicherten
Verlaufsdaten (`history`-Tabelle), gleiche Solaranteil-Heuristik wie bei der
Ladebilanz auf dem Dashboard.

## Speicher im Energiefluss-Diagramm

Ist unter „Batterie" ein Gerät konfiguriert, erscheint im Energiefluss-Diagramm auf
dem Dashboard jetzt zusätzlich ein „Speicher"-Knoten mit einer physikalisch
nachvollziehbaren Aufschlüsselung (passend zur Topologie Victron → Solar-MPPT →
Batterie, z. B. mit ESS-Zero-Feed-in):
- **Entladen:** Gesamtleistung = Batterie-Entladeleistung + Solarleistung (beides
  deckt gemeinsam den Hausverbrauch, Netzbezug bleibt nahe 0).
- **Laden:** zuerst aus Solarüberschuss, erst wenn der nicht reicht zusätzlich aus
  dem Netz. Reicht der Solarüberschuss für mehr als die Ladeleistung, wird der Rest
  als Einspeisung ins Netz angezeigt.

Die Kurzform steht im Diagramm selbst, die ausführliche Aufschlüsselung in der
Batterie-Liste darunter. Bei mehreren Batteriegeräten werden Leistungswerte für
das Diagramm summiert.

## API

- `GET /api/status` – aktueller Snapshot (auch über WebSocket `/ws` live, `{type:"snapshot", data:...}`)
- `GET /api/history?hours=24` – Verlaufsdaten für Charts
- `GET /api/history/daily?days=30` – Tageswerte für die Ladehistorie
- `GET /api/energy` – Ladebilanz (geladene Menge/Solaranteil, heute & gesamt)
- `GET /api/settings` / `PUT /api/settings` – Regelparameter (Phasenmodus, Ströme, ...)
- `POST /api/mode` – `{ "mode": "off" | "pv_only" | "min_plus_pv" | "fast" | "manual" }`
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
