# MyGym 🏋️

Kostenlose Gym-App fürs iPhone als Ersatz für Bezahl-Apps. Läuft als PWA
(Progressive Web App) — kein App Store, kein Konto, keine Kosten. Alle Daten
bleiben lokal auf dem Gerät (localStorage).

## Funktionen

- **Trainingsplan** mit Editor: Trainingstage und Übungen anlegen, bearbeiten,
  sortieren (Sätze, Wiederholungen, Pausenzeit, Notizen). Beispielplan
  (Push/Pull/Beine) ist vorinstalliert.
- **Satz-Tracking**: Während des Trainings Gewicht und Wiederholungen eintragen
  und Sätze abhaken. Werte vom letzten Training werden automatisch vorbelegt.
- **Pausen-Timer**: Startet automatisch beim Abhaken eines Satzes (pro Übung
  konfigurierbar), mit Signalton, +30 s und Überspringen.
- **Verlauf**: Alle Trainings mit Sätzen, Volumen und Dauer.
- **Statistik**: Gewichtsverlauf pro Übung, Wochenvolumen, Kennzahlen.
- **Übungs-Notizen**: z. B. Geräteeinstellungen — direkt im Training editierbar.
- **Export/Import** der Daten als JSON (Backup / Gerätewechsel).
- Offline-fähig (Service Worker), Bildschirm bleibt während des Trainings an
  (Wake Lock).

## Lokal testen

```bash
python3 -m http.server 8517 --directory .
```

Dann <http://localhost:8517> öffnen.

## Aufs iPhone bringen (empfohlen: GitHub Pages)

Die PWA braucht HTTPS (für Offline-Modus/Service-Worker). Am einfachsten:

1. Repo auf GitHub pushen.
2. Auf GitHub: **Settings → Pages → Source: Deploy from a branch**,
   Branch `main`, Ordner `/ (root)`.
3. Auf dem iPhone die Pages-URL in **Safari** öffnen.
4. **Teilen-Symbol → „Zum Home-Bildschirm“**. Fertig — die App startet
   dann im Vollbild wie eine native App und funktioniert auch offline.

> Hinweis: Nach Updates am Code einmal die Seite neu laden; der Service Worker
> holt sich die neue Version. Bei Änderungen an gecachten Dateien die
> `CACHE`-Version in `sw.js` hochzählen (z. B. `mygym-v2`).

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | App-Gerüst, Dialoge, Tab-Leiste |
| `styles.css` | Dunkles Design, für Daumen-Bedienung optimiert |
| `app.js` | Gesamte App-Logik (Plan, Training, Timer, Verlauf, Charts) |
| `sw.js` | Service Worker (Offline-Cache) |
| `manifest.webmanifest` | PWA-Manifest (Name, Icons, Vollbild) |
| `icons/` | App-Icons |
