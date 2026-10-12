# Graded Readers Español

App web instalável (PWA) para ler e ouvir histórias graduadas, offline, no PC e no telemóvel.

- Sem servidor e sem conta: os episódios importados ficam guardados só no dispositivo (IndexedDB).
- Cada episódio é um ficheiro `.json` (formato `graded-reader/1`) com texto, traduções, tempos do áudio, vocabulário, gramática, perguntas e o áudio em base64.
- Para publicar: basta servir esta pasta em HTTPS (GitHub Pages, Netlify, Firebase Hosting).
- Ao alterar ficheiros da app, sobe o número em `CACHE` no `sw.js` para os dispositivos receberem a atualização.
