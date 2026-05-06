# Recorder Video

Recorder Video é um gravador de tela para Windows focado em clareza. Ele captura o vídeo sem o cursor nativo, registra o movimento e os cliques do mouse com um sidecar nativo e gera um export com zoom inteligente nos momentos de atenção. O objetivo é entregar gravações profissionais sem exigir um editor pesado.

O app mantém os dados organizados por projeto: captura bruta + timeline de eventos do cursor + presets de exportação. Toda ação visível na interface executa algo real, mantendo o produto funcional em todas as etapas.

## Stack

![Electron](https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=000000)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?style=for-the-badge&logo=ffmpeg&logoColor=white)

- Electron fornece o shell desktop e a camada de janelas no Windows.
- React e TypeScript sustentam a UI, preview e edição.
- Rust lida com captura nativa e timeline do cursor.
- FFmpeg gera o MP4 final com presets de exportação.

## O Que Faz

- Grava a tela sem o cursor nativo do sistema.
- Captura movimentos e cliques em alta resolução temporal.
- Cria zoom automático ou manual nos momentos relevantes.
- Renderiza export com cursor customizado, fundo e enquadramento.
- Organiza projetos e exports na pasta de Vídeos.

## Como Funciona

1. O desktop app coordena a captura e cria o diretório do projeto.
2. O sidecar em Rust emite eventos do cursor como linhas JSON.
3. O renderer faz o preview e produz o stream de render.
4. O FFmpeg codifica o MP4 final com o preset escolhido.

Os projetos guardam mídia bruta e metadados separadamente:

- `capture.webm` ou `capture.mp4`: gravação base
- `timeline.json`: eventos do cursor e instruções de zoom
- `assets/`: derivados como thumbnails

## Princípios do Produto

- Nenhum controle visível fica sem ação real.
- Foco em captura limpa, movimento claro e export rápido.
- Experiência nativa e confiável no Windows.

## Comandos

```powershell
pnpm install
pnpm dev
pnpm check
```

## Estrutura

```text
apps/desktop           App desktop Electron + React
crates/recorder-core   Sidecar Rust de captura e cursor
docs                   Arquitetura e roadmap do produto
```
