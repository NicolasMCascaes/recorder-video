# Roadmap Produto FocuSee-Like

## Resumo

O app vai evoluir em fases curtas. A regra do produto daqui para frente e que nenhum botao visivel da UI principal fique decorativo: toda acao exposta precisa executar algo real, mesmo que ainda simples.

Nao vamos copiar marca, assets ou interface exata do FocuSee. O objetivo e aproximar comportamento, polimento e fluxo de gravacao/preview/export com identidade propria.

## Fase 1: Product Shell Funcional

Status: implementada.

- Sidebar com views reais:
  - Studio: gravacao, preview, editor de duracao e export.
  - Projects: lista projetos locais gravados.
  - Exports: lista exports MP4 existentes.
  - Settings: preferencias globais.
- IPCs minimos:
  - `project.list()`
  - `project.openFolder({ projectDir })`
  - `export.openFile({ outputPath })`
  - `settings.get()`
  - `settings.update(settings)`
- Trim foca a timeline de duracao.
- Playback settings controla:
  - velocidade de preview: `0.5x`, `1x`, `1.5x`, `2x`;
  - loop preview;
  - cursor customizado.
- Manual mode:
  - Auto usa zoom por cliques.
  - Manual desliga zoom automatico e mantem composicao, cursor e export sem zoom.
- Settings persistidas em `Videos/Recorder Video/settings.json`.

### Criterios De Aceite

- Nenhum botao visivel da UI principal fica sem acao.
- Sidebar troca views reais.
- Projects lista gravacoes locais e abre projeto.
- Exports lista MP4s gerados e abre arquivo/pasta.
- Settings salva e recarrega preferencias.
- Trim foca a timeline.
- Playback settings altera a reproducao do preview.
- Manual mode desliga o auto zoom no preview e no export.
- `pnpm check` e `pnpm build` passam.

## Fase 1.5: Motion Polish / Manual Zoom Inicial

Status: implementada.

- Renderizar preview/export com uma timeline de cursor suavizada, sem alterar eventos crus.
- Usar cursor suavizado como foco do zoom automatico.
- Salvar `edit.motion` por projeto.
- Em Manual, criar/atualizar/remover zoom no playhead atual.
- Mostrar zooms manuais como blocos reais na timeline.

## Fase 1.6: Captura Sem Cursor Nativo

Status: implementada.

- Usar `ffmpeg-gdigrab` como engine padrao no Windows.
- Gravar captura crua sem cursor nativo com `-draw_mouse 0`.
- Manter Rust sidecar capturando timeline do mouse.
- Manter Electron MediaRecorder como fallback.
- Salvar `captureEngine` no projeto para compatibilidade e debug.

## Fase 2: Editor De Motion

Status: implementada.

- Transformar cliques em segmentos de zoom editaveis na timeline.
- Permitir selecionar segmento e ajustar:
  - inicio;
  - duracao;
  - zoom;
  - suavidade.
- Manual passa a usar segmentos criados/editados pelo usuario.
- Adicionar opcao para ocultar/mostrar cursor no export por projeto.
- Manter preview e export no mesmo modelo visual.

## Fase 3: Aparencia FocuSee-Like

Status: implementada.

- Presets de background:
  - dark soft;
  - light soft;
  - blue Windows-like;
  - warm gradient.
- Ajustes por projeto:
  - tamanho da tela no canvas;
  - borda arredondada;
  - sombra;
  - estilo do cursor.
- Aplicar preferencias por projeto no preview e export.

## Fase 4: Export Profissional

Status: implementada.

- Presets de export:
  - High Quality;
  - Balanced;
  - Small File.
- Escolher destino do MP4.
- Cancelar export.
- Historico de exports por projeto.
- Abrir arquivo ou pasta direto pela UI.

## Fase 5: Captura Mais Completa

Status: implementada.

- Countdown antes de gravar.
- Pause/resume.
- Captura de janela ou regiao.
- Microfone e audio do sistema, se viavel no Windows/Electron.
- Melhorar remocao do cursor nativo da captura.

## Fase 5.5: Captura Confiavel e Selecao Externa

Status: planejada.

- Remover o fallback silencioso para `electron-mediarecorder` nos modos normais de captura.
- Garantir que `screen`, `region` e `window` gravem sem cursor nativo usando caminhos nativos-safe.
- Abrir selecao de regiao fora do app, em overlay fullscreen sobre todos os monitores.
- Permitir criar, mover e redimensionar a area selecionada antes de gravar.
- Melhorar selecao de tela e janela, sem thumbnails pequenos e sem cliques inconsistentes.
- Congelar audio novo nesta fase; foco total em confiabilidade de captura.
- Se um alvo nao puder garantir cursor zero, ele nao deve cair para Electron automaticamente; deve ficar indisponivel com mensagem clara.

## Fase 6: Produto Windows

- Empacotar instalador Windows.
- Criar icone e nome final.
- Preferencias globais mais completas.
- Onboarding curto.
- Erros recuperaveis com mensagens claras.

## Stack Mantida

- Electron + React + TypeScript para app Windows.
- Rust sidecar para captura/eventos nativos.
- WebM intermediario e MP4 final via FFmpeg.
