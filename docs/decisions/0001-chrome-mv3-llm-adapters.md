# ADR-0001: Chrome MV3 вместо VS Code, LLM через адаптеры провайдеров

**Статус:** Proposed (ждёт решения владельца продукта)
**Дата:** 2026-10-22

## Контекст

Прототип v0.1.0 — VS Code-расширение на Node API. Целевой канал — Chrome Web
Store, в семействе deterministic-extensions. Правила семейства: ядро без сети,
часов, случайности и DOM; LLM — отдельный адаптер; базовые операции без ключа;
пользовательский код не исполняется. Требование: много провайдеров LLM,
обязательно Anthropic, локальные модели, BYOK.

## Решение (предлагаемое)

1. **Форма продукта:** страница расширения (`app.html`), как в Code Compare Local.
   Без content scripts и без доступа к сайтам. Источник кода: вставка или файл,
   на следующем этапе — папка проекта через File System Access API
   (`showDirectoryPicker`).
2. **Ядро:** модули `deterministic-extensions/src/core` (документы и UTF-8,
   сессия, команды, stale/replay, Undo/Redo, gates), вендорятся с записью
   ревизии и checksum, как в code-compare-local (`src/vendor/.../provenance.json`).
3. **Поток:** интент + документ → адаптер LLM → JSON-предложение → строгая схема →
   `applySearchReplace` (уникальный непустой блок) → синтаксис и линт **новых**
   нарушений в worker → смысловой дифф → пользователь принимает команду целиком →
   Undo/Redo → Download / запись в файл. Автоисправление: максимум N запросов,
   каждая попытка — новая команда со своим ID.
4. **Адаптеры LLM** (один интерфейс `propose(request) → rawText`, отдельные gates):
   - Anthropic Messages API — обязателен в MVP;
   - OpenAI;
   - Google Gemini;
   - OpenAI-совместимый endpoint (OpenRouter, Groq, Together, LM Studio, vLLM, Ollama `/v1`);
   - Ollama native — опционально, если `/v1` окажется недостаточно.
5. **Ключи и доступ:** ключ хранится в `chrome.storage.local` (не `sync`), в
   логах и экспорте не появляется. Доступ к сети через `optional_host_permissions`,
   `chrome.permissions.request` вызывается на конкретный origin выбранного
   провайдера. CSP `connect-src` разрешает только https и loopback.
6. **Что удаляется:** `SandboxRunner`, `extension.ts`, `TimeMachine` (его заменяет
   сессия ядра), hash-chain logger, заявления о детерминизме генерации.
   Что переносится: `promptTemplates`, строгий `schemaParser` и
   `utils/patch.ts` из PR #1, правила линтера, `semanticDiff`, `commandCenter`.
7. **Парсер в браузере:** решить отдельным ADR (`typescript` в worker примерно 9 МБ
   против `@babel/parser` + typescript-плагин, который уже есть в семействе).

## Альтернативы

- **Остаться в VS Code / Open VSX.** Работа с файлами проекта нативная, PR #1 почти
  готов. Минусы: не тот канал, концепция семейства браузерная.
- **Content scripts в web-IDE (StackBlitz, Replit, claude.ai, ChatGPT).** Минусы:
  широкие host permissions, углублённая модерация CWS, хрупкие DOM-интеграции.
  Можно вернуться к этому после MVP.
- **Собственный прокси-сервер для LLM.** Минусы: стоит денег, мы храним чужой
  код, это противоречит local-first.

## Последствия

- Проект по сути пишется заново на стеке семейства (ES modules, Node 24.15+,
  Playwright для проверки установленного расширения). Ценность текущего кода —
  алгоритмы и тесты, а не обвязка.
- Нужны privacy policy и раскрытие в CWS «код отправляется выбранному вами
  провайдеру», иначе модерация и Limited Use policy станут проблемой.
- Проверить до реализации: прямые запросы к Anthropic из extension page
  (заголовок `anthropic-dangerous-direct-browser-access`), и что Ollama принимает
  origin `chrome-extension://` (`OLLAMA_ORIGINS`).

## Открытые вопросы для владельца

1. Этот репозиторий (история сохраняется) или новый из `scripts/new-project.py`?
2. Мержить ли PR #1 как финальное состояние VS Code-прототипа?
3. Нужен ли голосовой ввод в MVP? Web Speech API в Chrome отправляет звук на
   серверы Google, это ещё одна внешняя передача данных.
