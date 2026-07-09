# Keba PV-Überschussladen

Home-Assistant-App (früher „Add-on" genannt, Node.js/TypeScript) mit eigenem
Dashboard, das deine **Keba KeContact P30c** per Modbus TCP so regelt, dass
möglichst nur PV-Überschuss zum Laden verwendet wird. Läuft als App unter dem
Supervisor, erscheint per Ingress direkt in der HA-Sidebar (kein Portforwarding,
keine eigene Authentifizierung nötig - läuft über deine HA-Anmeldung).

## Installation über dein GitHub-Repository

Home Assistant hat „Add-ons" zu „Apps" umbenannt (Settings → Apps statt
Settings → Add-ons) und verlangt seit einem Update in 2026 zwingend eine
`repository.yaml` im Root des Git-Repos, damit ein Repo überhaupt als
App-Repository erkannt wird - das war früher optional, ist jetzt aber Pflicht.
Genau das hat bei dir gefehlt bzw. wurde jetzt ergänzt.

**Repo-Struktur, wie sie jetzt in diesem ZIP vorliegt:**

```
PV-charger/                    <- Repo-Root
├── repository.yaml            <- Pflicht, identifiziert das Repo
└── keba_pv_charger/           <- die eigentliche App
    ├── config.yaml
    ├── Dockerfile
    ├── src/
    ├── public/
    └── ...
```

1. **Wichtig: Repository auf „Public" stellen.** Der Fehler `could not read
   Username for 'https://github.com'` heißt, dass GitHub Zugangsdaten will -
   das passiert bei privaten Repos, da der Supervisor sich nicht anmelden
   kann. Auf GitHub: Repo → **Settings → General → Danger Zone → Change
   visibility → Make public**.
2. Inhalt dieses ZIPs (inkl. `repository.yaml` im Root!) so in dein Repo
   pushen, dass die Struktur oben exakt passt - `repository.yaml` muss direkt
   im Repo-Root liegen, nicht in einem Unterordner.
3. In Home Assistant: **Settings → Apps → App-Store → oben rechts ⋮ →
   Repositories → URL einfügen** (`https://github.com/mrameis/PV-charger`,
   ohne `.git` am Ende probieren falls es weiter Probleme gibt) → **Hinzufügen**.
4. Nach dem Hinzufügen taucht **„Keba PV-Überschussladen"** in der App-Liste
   auf. Installieren, im Tab **„Konfiguration"** deine IPs eintragen (siehe
   Tabelle unten), danach **Starten**.
5. Im Tab **„Info"** die Option **„In Sidebar anzeigen"** aktivieren - das
   Dashboard erscheint dann als eigener Menüpunkt „PV-Laden" in der Sidebar.

Falls es nach dem Hinzufügen der Repo-URL weiterhin Fehler gibt: **Settings →
System → Logs → Supervisor** öffnen, dort steht die genaue Fehlermeldung
(z. B. „Invalid schema" wenn irgendwo ein Feld falsch geschrieben ist).

Falls Modbus/HTTP-Zugriffe auf Keba/Shelly/Fronius/Steca/Victron aus der App
heraus fehlschlagen (Docker-Bridge-Netzwerk kann das je nach HAOS-Netzwerksetup
blockieren): in `keba_pv_charger/config.yaml` `host_network: true` ergänzen,
App neu bauen - das lässt den Container das gleiche Netzwerk wie HA selbst nutzen.

### Alternative: als lokale App ohne GitHub

Statt über GitHub kannst du `keba_pv_charger/` (den Unterordner, ohne
`repository.yaml`) auch direkt nach `/addons/local/keba_pv_charger/` auf der
HAOS-VM kopieren (per Samba/SSH-Add-on) - dann taucht die App unter „Lokale
Apps" auf, ganz ohne Git/GitHub.

### Optional: eigenständiger Betrieb ohne HA (docker-compose)

Falls du das Projekt stattdessen unabhängig von Home Assistant auf einem eigenen
Docker-Host laufen lassen willst, liegen `docker-compose.yml` und `.env.example`
in diesem Ordner (`keba_pv_charger/`) bei - dann `cp .env.example .env`, IPs
eintragen, `docker compose up -d --build`. In diesem Modus läuft es NICHT als
App und hat kein Ingress, dafür ein eigenes Dashboard auf Port 8080.

## Architekturentscheidung: eine Wahrheit für den Regelkreis

Der Regelkreis (Ladestrom rauf/runter, Phasenumschaltung) basiert **ausschließlich**
auf der Netzleistung deines **Shelly 3EM** am Hausanschluss (positiv = Bezug,
negativ = Einspeisung/Überschuss). Das ist exakt das Prinzip, das auch evcc/openWB
verwenden ("Selbstverbrauchsregler") und ist robuster als das Aufsummieren mehrerer
Wechselrichter, die je nach Firmware unterschiedlich schnell/genau melden.

Fronius, StecaGrid 6003 und Victron werden **zusätzlich** ausgelesen und im Dashboard
angezeigt (Aufschlüsselung, wer wie viel erzeugt / Batterie-Status), beeinflussen aber
nicht die Regelung selbst. Fällt einer dieser optionalen Adapter aus, läuft die
PV-Überschussladung trotzdem normal weiter.

## Vor der Inbetriebnahme: Wallbox konfigurieren

1. An der Keba P30c: DIP-Schalter **DSW1.3 = ON** (aktiviert Modbus TCP). Modbus TCP
   und die UDP-Schnittstelle können **nicht gleichzeitig** verwendet werden – falls du
   die Wallbox aktuell per UDP ansprichst (z. B. altes Loxone/openWB-Modul), das vorher
   deaktivieren.
2. Port 502 muss vom Docker-Host aus erreichbar sein (gleiches LAN/VLAN wie die Wallbox).
3. Für die automatische Phasenumschaltung muss an der Wallbox das **S10-Zubehör** bzw.
   die entsprechende Konfiguration aktiv sein. Falls du das nicht hast, setze die
   Add-on-Option `charge_phases_mode` auf `1` oder `3` (feste Phasenzahl) statt `auto`.

## ⚠️ Wichtig: Register-Verifizierung vor Produktivbetrieb

Die Modbus-Registeradressen in `src/keba/modbus.ts` stammen aus KEBAs offiziellem
"Modbus TCP Programmers Guide" und mehreren übereinstimmenden Praxisberichten, sind
aber je nach Firmware-Version nicht zu 100 % garantiert identisch (bekanntes Beispiel:
manche Firmware-Stände liefern die Gesamtenergie im Register 1036 um den Faktor 10 zu
hoch). Bitte **vor dem ersten unbeaufsichtigten Lauf**:

1. Container starten, Dashboard öffnen, mit angestecktem (aber idealerweise noch nicht
   ladendem) Auto den angezeigten Status, Strom und Phasen gegen das Display der
   Wallbox / die KEBA eMobility App gegenchecken.
2. Modus zunächst auf **„Aus“** lassen und nur beobachten (Container schreibt in diesem
   Modus lediglich `enabled=false`, sonst nichts).
3. Danach kurz **„Schnell“** testen (fixer Strom, keine Überschusslogik) und prüfen, ob
   der am Fahrzeug ankommende Strom zum eingestellten Wert passt.
4. Erst danach „Min + PV“ bzw. „Nur PV“ aktivieren.
5. Automatische Phasenumschaltung: einmal manuell im Auge behalten, ob die Umschaltung
   wirklich greift (manche Firmware-Versionen setzen sie laut Community-Berichten nicht
   zuverlässig um). Falls nicht: Add-on-Option `charge_phases_mode` auf `1` oder `3`
   fixieren.

## Konfiguration

Alle Einstellungen im Add-on-Tab **„Konfiguration"** (Feldnamen = `schema` in
`config.yaml`). Für den optionalen Standalone-Betrieb identisch über `.env`
(Groß-/Unterstrich-Variante, siehe `.env.example`).

Wichtige Werte für dein Setup:

| Add-on-Option | Wert bei dir |
|---|---|
| `keba_host` / `keba_port` / `keba_unit_id` | IP der P30c, Port 502, Unit-ID 255 |
| `shelly3em_host` | IP deines Shelly 3EM (Netzzähler) |
| `shelly3em_generation` | `gen1`, außer du hast eine Pro-3EM (`gen2`) |
| `charge_min_current_a` / `charge_max_current_a` | `6` / `16` (dein Setup: 1–3 Phasen) |
| `charge_phases_mode` | `auto`, falls S10-Umschaltung vorhanden und getestet |

## Betrieb (Add-on)

Start/Stopp/Logs über den normalen Add-on-Tab in Home Assistant. Bei Konfigurations-
änderungen genügt „Neu starten" - die Werte werden beim Start aus `/data/options.json`
gelesen, `/data` bleibt zwischen Neustarts/Updates erhalten (History-Datenbank liegt
dort ebenfalls, `history.db`).

Dashboard: über die HA-Sidebar („PV-Laden") oder direkt im Add-on-Tab über den
„Open Web UI"-Knopf (falls Ingress aktiviert ist, was per Default der Fall ist).

## Lademodi im Dashboard

- **Aus** – Wallbox gesperrt, keine Ladung.
- **Nur PV** – lädt ausschließlich mit Überschuss, pausiert (0 A) wenn nicht genug
  Überschuss für den Mindeststrom (6 A) vorhanden ist.
- **Min + PV** – garantiert mindestens 6 A, sobald ein Auto angesteckt ist, nutzt
  darüber hinaus vorhandenen Überschuss.
- **Schnell** – lädt mit maximalem Strom (16 A), ignoriert PV-Überschuss.

## API

- `GET /api/status` – aktueller Snapshot (auch über WebSocket `/ws` live)
- `GET /api/history?hours=24` – Verlaufsdaten für Charts
- `GET /api/config` – aktuelle Regelparameter
- `POST /api/mode` – `{ "mode": "off" | "pv_only" | "min_plus_pv" | "fast" }`

## Bekannte Stolpersteine

- **Failsafe:** Die Keba hat einen Watchdog – ohne regelmäßige Modbus-Kommandos fällt
  sie auf einen Sicherheitswert zurück. Der Regelkreis schreibt daher bei jedem Tick
  (Standard alle 10 s) erneut den Sollstrom, auch wenn er sich nicht ändert.
- **StecaGrid-XML-Pfad:** ältere Steca-Wechselrichter haben je nach Firmware
  unterschiedliche XML-Pfade. Falls im Log `Steca: kein Leistungswert gefunden`
  erscheint, den tatsächlichen Pfad im Browser suchen und als Add-on-Option
  `steca_xml_path` eintragen (z. B. `/measurements.xml`).
- **Victron-Register:** mit mittlerer Sicherheit übernommen, siehe Kommentar in
  `src/energy/victron.ts`. Nur für die Anzeige relevant, nicht für die Regelung.
