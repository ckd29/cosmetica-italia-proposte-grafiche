# Cosmetica Italia — Restyling sito, proposte grafiche

Prototipi navigabili delle proposte grafiche per il nuovo sito di Cosmetica Italia, pubblicati con GitHub Pages.

- `index.html` — landing page: il pulsante principale apre la proposta homepage (Proposta 8, versione 1.2); sotto ci sono le altre tavole.
- `*.dc.html` — le tavole esportate dal progetto di design (desktop e ritagli mobile 390 px).
- `assets/` — immagini e video usati dalle tavole.
- `_runtime/` — script che fanno girare le tavole nel browser.
- `canvas.json` — disposizione delle tavole nel progetto originale.
- `.nojekyll` — serve a GitHub Pages per pubblicare anche `_runtime/` (Jekyll ignorerebbe le cartelle che iniziano con `_`).

## Pubblicazione su GitHub Pages

1. Crea la repository su GitHub e fai push del branch `main`.
2. In **Settings → Pages**: *Source* = **Deploy from a branch**, branch **main**, cartella **/ (root)**.
3. Il sito sarà su `https://<utente-o-organizzazione>.github.io/<nome-repo>/`.

Nota: con un piano GitHub gratuito Pages funziona solo su repository pubbliche, e il sito pubblicato è comunque visibile a chiunque abbia il link.

## Vedere le tavole in locale

Le tavole vanno aperte da un server web, non con doppio clic sul file:

```sh
python3 -m http.server 8000
# poi apri http://localhost:8000/
```
