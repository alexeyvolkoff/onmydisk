# Agent Instructions

# Global Agent Instructions
## Knowledge Management
- Before exploring any topic, first check `.knowledge/` directory in the project root for existing research notes
- If relevant and up-to-date knowledge exists, skip exploration and use what's there
- When explore sub-agent discovers new findings, save them to `.knowledge/<topic>.md` using descriptive filenames
- Always keep `.knowledge/` organized — one file per topic, cross-link when needed

## TOOL_USE RULES (CRITICAL)
1. **Prevent Empty Output**: Standard tools (grep, ls, find, git) sometimes return nothing. To prevent the agent from hanging:
   - ALWAYS append `|| echo "NO_OUTPUT_RETURNED"` to any command that might return an empty string.
   - Example: `grep "pattern" file.txt || echo "pattern not found"`
2. **No Retries on Empty**: If a command returns "NO_OUTPUT_RETURNED", do not loop. Accept it as a valid result and move to the next logical step.

3. Never try to rebuild or restart Docker containers. It is done by CI
4. Never try to restart or investigate nginx proxy. This project runs on staging environment, not locally.
5. Never rebuild the frontend. It is done by CI
6. Never call shell commands that require sudo



## SYSTEM COMPATIBILITY (Ubuntu 24.04)
- Use standard bash syntax. 
- If a tool call fails with "undefined" error, check if you missed the description field and fix it immediately.

## UI/UX & FRONTEND DEVELOPMENT RULES
1. **Поддержка тем и дизайн-система (Theming & omd.css)**:
   - Всегда при добавлении новых визуальных компонентов поддерживай тёмную и светлую темы (`dark-theme` / `light-theme`, а также системную тему `prefers-color-scheme`).
   - Для обеих тем строго придерживайся дизайн-системы `omd.css` (канонические токены цветов, фонов, текста, границ, радиусов и теней). Не допускай рассинхронизации цветов (например, тёмный текст на тёмном фоне или белый на белом).
2. **Локализация для всех поддерживаемых языков (i18n)**:
   - При добавлении новых строковых элементов интерфейса локализация обязана добавляться для **всех** поддерживаемых проектом языков (все файлы в `svar/src/lib/i18n/locales/`), а не только для английского и русского.
3. **Запрет на системные браузерные окна (No Native Alerts/Prompts)**:
   - Никогда не используй системные браузерные попапы, конфирмы и промпты (`alert()`, `confirm()`, `prompt()`).
   - Всегда используй готовые модальные окна/диалоги проекта либо создавай новые компоненты модалок в едином стиле приложения.


