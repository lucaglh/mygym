# MyGym 🏋️

Kostenlose Gym-App fürs iPhone als Ersatz für Bezahl-Apps. Läuft als PWA
(Progressive Web App) — kein App Store, kein Konto, keine Kosten. Alle Daten
bleiben lokal auf dem Gerät (localStorage).

## Funktionen (v2)

- **Start-Dashboard**: Begrüßung, Wochenübersicht, Wochen-Streak und
  Trainingsvorschlag per Rotation durch den Plan.
- **Trainingsplan** mit Editor: Tage anlegen, umbenennen, duplizieren,
  sortieren, löschen; Übungen mit Sätzen, Wiederholungen, Pausenzeit und
  Notizen, inkl. Autovervollständigung aus ~40 gängigen Übungen. Beispielplan
  (Push/Pull/Beine) ist vorinstalliert.
- **Satz-Tracking**: Werte vom letzten Training vorbelegt („Letztes Mal: …“),
  Fortschrittsbalken, fertige Übungen klappen automatisch zusammen,
  Live-🏆-PR-Badge bei neuem Maximalgewicht.
- **Pausen-Timer**: Startet automatisch beim Abhaken (pro Übung konfigurierbar),
  zeigt die Übung an, Signalton + Vibration, +30 s, Puls-Animation am Ende.
- **Zusammenfassung** nach jedem Training: Dauer, Sätze, Volumen, neue
  Bestleistungen und Volumenvergleich zum letzten gleichen Training.
- **Verlauf**: Nach Monat gruppiert, aufklappbar, mit Volumen und Dauer.
- **Statistik**: Aktivitäts-Heatmap (12 Wochen), Übungs-Fortschritt mit
  Metrik- (Max/e1RM/Volumen) und Zeitraum-Umschalter, Wochenvolumen,
  Bestwerte-Tabelle (schwerster Satz + geschätztes 1RM) und
  Körpergewichts-Tracking mit Verlauf.
- **Einstellungen**: Ton, Vibration, Standard-Pause, Export/Import (JSON),
  Alles-zurücksetzen.
- Offline-fähig (Service Worker) mit Update-Hinweis in der App; Bildschirm
  bleibt während des Trainings an (Wake Lock).

## Lokal testen

```bash
python3 dev-server.py 8517
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
