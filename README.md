# MyGym 🏋️

Kostenlose Gym-App fürs iPhone als Ersatz für Bezahl-Apps. Läuft als PWA
(Progressive Web App) — kein App Store, kein Konto, keine Kosten. Alle Daten
bleiben lokal auf dem Gerät (localStorage).

## Funktionen (v2)

- **Start-Dashboard**: Begrüßung, Wochenübersicht, Wochen-Streak und
  Trainingsvorschlag per Rotation durch den Plan.
- **Trainingsplan** mit Editor: Tage anlegen, umbenennen, duplizieren,
  sortieren, löschen; Übungen mit Sätzen, Wiederholungen, **Trainingsgewicht**,
  **Sitzposition**, Pausenzeit und Notizen, inkl. Autovervollständigung aus
  ~40 gängigen Übungen. Beispielplan (Push/Pull/Beine) ist vorinstalliert.
- **Übungs-Piktogramme**: 16 gezeichnete SVG-Symbole (Bankdrücken, Kniebeugen,
  Latzug, Curls …), automatisch per Übungsname zugeordnet, manuell wählbar.
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
- **Ernährung (Whoop-Kalorien)**: Tagesziel aus dem echten Verbrauch statt aus
  Faustformeln — siehe unten.
- **Einstellungen**: Ton, Vibration, Standard-Pause, Export/Import (JSON),
  Whoop-Import, Alles-zurücksetzen.
- Offline-fähig (Service Worker) mit Update-Hinweis in der App; Bildschirm
  bleibt während des Trainings an (Wake Lock).

## Kalorien aus Whoop-Daten (Tab „Essen“)

Wer viel läuft, verbrennt im Alltag oft mehr, als jede Faustformel schätzt — und
nimmt trotz „genug essen“ nicht zu. Der Tab **Essen** rechnet deshalb mit dem
gemessenen Verbrauch:

1. **Körperdaten & Ziel** eintragen (Geschlecht, Alter, Größe, Gewicht,
   gewünschte Zunahme pro Woche, Eiweiß/Fett pro kg).
2. **Whoop-Verbrauch** hinzufügen — zwei Wege:
   - *Täglich eintragen*: den Wert „Kalorien verbrannt“ aus der Whoop-App
     (für heute oder gestern).
   - *CSV-Import*: Whoop-App → Profil → **Daten exportieren**; aus der Mail die
     Datei `physiological_cycles.csv` auswählen oder ihren Inhalt einfügen.
     Erkannt werden Datum, „Energy burned“ (kcal oder kJ) und „Day Strain“,
     auch mit deutschem Zahlen-/Trennzeichenformat.
3. **Essen tracken** — Schnell-Buttons (+250/+500/+750) oder Mahlzeit mit
   Bezeichnung, kcal und Eiweiß.

**So entsteht das Tagesziel:**

```
Ø Tagesverbrauch (letzte 7 vollständige Whoop-Tage)
+ Aufbau-Überschuss  (Ziel-kg pro Woche × 7700 kcal ÷ 7)
+ Feinjustierung     (vom Coach nach echter Gewichtsentwicklung)
= Tagesziel
```

Der laufende Tag zählt nicht in den Schnitt, weil sein Wert erst am Abend
vollständig ist; liegt er deutlich über dem Schnitt, weist die App darauf hin.
Ohne Whoop-Daten wird ersatzweise mit Mifflin-St-Jeor-Grundumsatz × Aktivitäts-
faktor gerechnet.

**Coach**: Aus den Körpergewichts-Einträgen (Tab „Statistik“, 2–3× pro Woche)
wird per linearer Regression der Trend in kg/Woche bestimmt. Weicht er vom Ziel
ab, schlägt die App eine Anpassung des Tagesziels vor (max. ±400 kcal,
frühestens alle 7 Tage) — anwenden per Knopfdruck.

Alles läuft lokal: kein Whoop-Konto, kein API-Schlüssel, kein Server. Eine
direkte Whoop-Anbindung wäre nur mit eigenem Entwickler-Zugang **und** einem
Server für den OAuth-Tokentausch möglich.

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
