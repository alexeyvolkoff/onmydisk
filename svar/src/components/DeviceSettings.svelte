<script>
  import { onMount, createEventDispatcher } from "svelte";
  import { _, translate } from "../lib/i18n/index.js";

  export let drive = null;
  export let deviceName = "";
  export let deviceIcon = "";
  export let deviceType = "";
  export let isDarkTheme = false;

  const dispatch = createEventDispatcher();

  let loading = true;
  let saving = false;
  let settings = null;
  let errorMsg = "";

  // reveal state for password fields
  let revealed = {};
  let copiedKey = "";

  const nasFields = [
    { key: "automount", label: "Automount Drives", i18nKey: "automount_label" },
    { key: "updateSamba", label: "Update Samba", i18nKey: "updateSamba_label" },
    { key: "autoreindex", label: "Auto Reindex", i18nKey: "autoreindex_label" },
  ];

  const aiFields = [
    { key: "aiBase", label: "AI Base URL", type: "text" },
  ];
  const searchFields = [
    { key: "localSearchBase", label: "Search Base URL", type: "text" },
  ];

  // Readonly fields
  const readonlyFields = [
    { key: "linkId", label: "Link ID", i18nKey: "link_id" },
    { key: "server", label: "Gateway", i18nKey: "gateway" },
  ];
  onMount(async () => {
    if (!drive) { loading = false; return; }
    try {
      settings = await drive.getSettings();
    } catch (err) {
      errorMsg = "Failed to load settings: " + err.message;
    } finally {
      loading = false;
    }
  });

  function hasField(key) {
    return settings && typeof settings[key] !== "undefined";
  }

  function hasSection(section) {
    if (!settings || !section) return true;
    if (section === "nas") return hasField("automount") || hasField("updateSamba") || hasField("autoreindex");
    if (section === "ai") return hasField("localAI") || hasField("aiBase");
    return true;
  }

  function toggleReveal(key) {
    revealed[key] = !revealed[key];
  }

  async function copyToClipboard(text, key) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch (_) {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = ""; }, 1800);
  }

  async function apply() {
    if (!drive || !settings) return;
    saving = true;
    errorMsg = "";
    try {
      await drive.setSettings(settings);
      dispatch("saved", settings);
      dispatch("close");
    } catch (err) {
      errorMsg = "Failed to save: " + err.message;
    } finally {
      saving = false;
    }
  }

  let checkingUpdate = false;
  let applyingUpdate = false;
  let otaMessage = "";

  async function handleCheckUpdate() {
    if (!drive || checkingUpdate) return;
    checkingUpdate = true;
    otaMessage = "";
    try {
      const res = await drive.sendRPC("CheckUpdate", {});
      if (res && res.result) {
        settings.updateAvailable = res.result.updateAvailable;
        settings.newVersion = res.result.newVersion;
        settings.appVersion = res.result.currentVersion || settings.appVersion;
        otaMessage = res.result.updateMessage || (res.result.updateAvailable ? "New version available!" : "Up to date");
      }
    } catch (err) {
      otaMessage = "Check failed: " + err.message;
    } finally {
      checkingUpdate = false;
    }
  }

  async function handleApplyUpdate() {
    if (!drive || applyingUpdate) return;
    applyingUpdate = true;
    otaMessage = "Initiating update... Device will restart.";
    try {
      const res = await drive.sendRPC("ApplyUpdate", {});
      if (res && res.result && res.result.message) {
        otaMessage = res.result.message;
      }
    } catch (err) {
      otaMessage = "Update failed: " + err.message;
      applyingUpdate = false;
    }
  }

  function cancel() {
    dispatch("close");
  }

  function handleKeydown(e) {
    if (e.key === "Escape") cancel();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="modal-backdrop" on:click|self={cancel}>
  <div class="modal-card" class:dark-theme={isDarkTheme} class:light-theme={!isDarkTheme}>
    <div class="modal-header">
      <div class="header-info">
        <div class="header-icon">
          {#if deviceIcon}
            <i class={deviceIcon}></i>
          {:else if deviceType === "desktop"}
            <i class="wxi-desktop"></i>
          {:else if deviceType === "phone"}
            <i class="wxi-phone"></i>
          {:else if deviceType === "tablet"}
            <i class="wxi-tablet"></i>
          {:else}
            <i class="wxi-embedded"></i>
          {/if}
        </div>
        <div class="header-text">
          <div class="header-title-row">
            <h3 class="modal-title">{$_("device_settings", {}, "Device Settings")}</h3>
            {#if settings?.linkId}
              <span class="device-badge">
                <span class="pulse-dot-sm"></span>
                <span>Online</span>
              </span>
            {/if}
          </div>
          <p class="modal-sub">{deviceName || $_("unknown_device", {}, "Unknown Device")}</p>
        </div>
      </div>
      <button class="close-btn" on:click={cancel} aria-label={$_("close", {}, "Close")}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="modal-body">
      {#if loading}
        <div class="loading-wrap">
          <div class="spinner"></div>
          <span>{$_("loading", {}, "Loading settings...")}</span>
        </div>
      {:else if errorMsg}
        <div class="error-msg">{errorMsg}</div>
      {:else if settings}
        <div class="settings-grid">
          <!-- LEFT COLUMN: System & Drives -->
          <div class="settings-col">
            <!-- General / Hostname -->
            {#if hasField("hostname")}
              <div class="panel-card">
                <div class="panel-header">
                  <div class="panel-title">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                    <span>{$_("general", {}, "General")}</span>
                  </div>
                </div>
                <div class="field-input">
                  <label class="field-label-sm">{$_("hostname", {}, "Device Name")}</label>
                  <input type="text" bind:value={settings.hostname} class="text-input" placeholder="Device Name" />
                </div>
              </div>
            {/if}

            <!-- Storage & Drives Section -->
            {#if hasSection("nas")}
              <div class="panel-card">
                <div class="panel-header">
                  <div class="panel-title">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    <span>{$_("device", {}, "Storage & Drives")}</span>
                  </div>
                </div>
                <div class="panel-content-rows">
                  {#each nasFields as field}
                    {#if hasField(field.key)}
                      <div class="field-row">
                        <label class="field-label">{$_(field.i18nKey, {}, field.label)}</label>
                        <label class="switch">
                          <input type="checkbox" bind:checked={settings[field.key]} />
                          <span class="slider"></span>
                        </label>
                      </div>
                    {/if}
                  {/each}
                </div>
              </div>
            {/if}

            <!-- System & OTA Updates Section -->
            <div class="panel-card">
              <div class="panel-header">
                <div class="panel-title">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                  <span>{$_("system_and_updates", {}, "System & Updates")}</span>
                </div>
                <button class="check-update-btn" type="button" on:click={handleCheckUpdate} disabled={checkingUpdate || applyingUpdate}>
                  {#if checkingUpdate}
                    <div class="spinner-sm"></div>
                    <span>{$_("checking", {}, "Checking...")}</span>
                  {:else}
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                    <span>{$_("check_updates", {}, "Check")}</span>
                  {/if}
                </button>
              </div>

              <div class="version-row">
                <span class="version-label">{$_("agent_version", {}, "Agent Version")}</span>
                <span class="version-badge">{settings.appVersion || "2.1.5"}</span>
              </div>

              {#if settings.updateAvailable}
                <div class="update-banner">
                  <div class="update-banner-info">
                    <span class="pulse-dot"></span>
                    <div>
                      <div class="update-banner-title">{$_("update_available", {}, "New version available")}</div>
                      <div class="update-banner-ver">v{settings.newVersion}</div>
                    </div>
                  </div>
                  <button class="update-now-btn" type="button" on:click={handleApplyUpdate} disabled={applyingUpdate}>
                    {#if applyingUpdate}
                      <div class="spinner-sm"></div>
                      <span>{$_("updating", {}, "Updating...")}</span>
                    {:else}
                      <span>{$_("update_now", {}, "Update Now")}</span>
                    {/if}
                  </button>
                </div>
              {/if}

              {#if otaMessage}
                <div class="ota-status-msg" class:success={!otaMessage.includes("failed") && !otaMessage.includes("Error")}>
                  {otaMessage}
                </div>
              {/if}
            </div>
          </div>

          <!-- RIGHT COLUMN: Services & Connectivity -->
          <div class="settings-col">
            <!-- AI / Chat Service Section -->
            {#if hasField("localAI") || hasField("aiBase")}
              <div class="panel-card highlight-card">
                <div class="panel-header">
                  <div class="panel-title">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    <span>{$_("local_ai", {}, "AI & Chat Service")}</span>
                  </div>
                  {#if hasField("localAI")}
                    <label class="switch">
                      <input type="checkbox" bind:checked={settings.localAI} />
                      <span class="slider"></span>
                    </label>
                  {/if}
                </div>

                {#if !settings.localAI && hasField("localAI")}
                  <div class="service-disabled-notice">
                    {$_("ai_service_disabled_hint", {}, "AI & chat service is disabled on this device.")}
                  </div>
                {:else}
                  <div class="subfields-list">
                    {#each aiFields as field}
                      {#if hasField(field.key)}
                        <div class="field-input">
                          <label class="field-label-sm">{field.label}</label>
                          {#if field.type === "password"}
                            <div class="token-input-wrap">
                              <input
                                type={revealed[field.key] ? "text" : "password"}
                                bind:value={settings[field.key]}
                                class="text-input token-input"
                                autocomplete="off"
                                spellcheck="false"
                              />
                              <button class="icon-btn" type="button" title={revealed[field.key] ? $_("hide_key", {}, "Hide") : $_("show_key", {}, "Show")} on:click={() => toggleReveal(field.key)}>
                                {#if revealed[field.key]}
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                                {:else}
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                {/if}
                              </button>
                              <button class="icon-btn" type="button" title={$_("copy", {}, "Copy")} on:click={() => copyToClipboard(settings[field.key] || "", field.key)}>
                                {#if copiedKey === field.key}
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                                {:else}
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>
                                {/if}
                              </button>
                            </div>
                          {:else}
                            <input type="text" bind:value={settings[field.key]} class="text-input" placeholder="http://localhost:4000" />
                          {/if}
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}

            <!-- Local Search Section -->
            {#if hasField("localSearch")}
              <div class="panel-card">
                <div class="panel-header">
                  <div class="panel-title">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <span>{$_("local_search", {}, "Local Search")}</span>
                  </div>
                  <label class="switch">
                    <input type="checkbox" bind:checked={settings.localSearch} />
                    <span class="slider"></span>
                  </label>
                </div>

                {#if !settings.localSearch}
                  <div class="service-disabled-notice">
                    {$_("search_service_disabled_hint", {}, "Local search indexing is disabled on this device.")}
                  </div>
                {:else}
                  <div class="subfields-list">
                    {#each searchFields as field}
                      {#if hasField(field.key)}
                        <div class="field-input">
                          <label class="field-label-sm">{field.label}</label>
                          {#if field.type === "password"}
                            <div class="token-input-wrap">
                              <input
                                type={revealed[field.key] ? "text" : "password"}
                                bind:value={settings[field.key]}
                                class="text-input token-input"
                                autocomplete="off"
                                spellcheck="false"
                              />
                              <button class="icon-btn" type="button" title={revealed[field.key] ? $_("hide_key", {}, "Hide") : $_("show_key", {}, "Show")} on:click={() => toggleReveal(field.key)}>
                                {#if revealed[field.key]}
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                                {:else}
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                {/if}
                              </button>
                              <button class="icon-btn" type="button" title={$_("copy", {}, "Copy")} on:click={() => copyToClipboard(settings[field.key] || "", field.key)}>
                                {#if copiedKey === field.key}
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                                {:else}
                                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>
                                {/if}
                              </button>
                            </div>
                          {:else}
                            <input type="text" bind:value={settings[field.key]} class="text-input" placeholder="http://localhost:8080" />
                          {/if}
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}

            <!-- Readonly Identity Section -->
            <div class="panel-card readonly-panel">
              <div class="panel-header">
                <div class="panel-title">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                  <span>{$_("identity", {}, "Identity")}</span>
                </div>
              </div>
              <div class="readonly-fields-wrap">
                {#each readonlyFields as field}
                  {#if hasField(field.key)}
                    <div class="field-input">
                      <div class="field-label-sm-row">
                        <label class="field-label-sm">{$_(field.i18nKey, {}, field.label)}</label>
                        {#if settings[field.key]}
                          <button
                            class="copy-link-btn"
                            type="button"
                            on:click={() => copyToClipboard(settings[field.key], field.key)}
                            title={$_("copy", {}, "Copy")}
                          >
                            {#if copiedKey === field.key}
                              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                              <span>{$_("copied", {}, "Copied")}</span>
                            {:else}
                              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>
                              <span>{$_("copy", {}, "Copy")}</span>
                            {/if}
                          </button>
                        {/if}
                      </div>
                      <input type="text" value={settings[field.key]} readonly class="text-input readonly" />
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          </div>
        </div>
      {/if}
    </div>

    <div class="modal-footer">
      <button class="btn btn-secondary" on:click={cancel} disabled={saving}>{$_("cancel", {}, "Cancel")}</button>
      <button class="btn btn-primary" on:click={apply} disabled={saving || loading}>
        {saving ? $_("saving", {}, "Saving...") : $_("apply", {}, "Apply")}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(5px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    padding: 20px;
    box-sizing: border-box;
  }

  .modal-card {
    width: 100%;
    max-width: 860px;
    border-radius: 16px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(148, 163, 184, 0.2);
    animation: modalAppear 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    max-height: 88vh;
  }

  @keyframes modalAppear {
    from { opacity: 0; transform: scale(0.97) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .light-theme { background: #ffffff; color: #101c22; border-color: #d6dde1; }
  .dark-theme { background: #202a2f; color: #ffffff; border-color: #3d4f57; }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 24px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.15);
  }
  .light-theme .modal-header { border-bottom-color: #e2e8f0; }
  .dark-theme .modal-header { border-bottom-color: #334155; }

  .header-info { display: flex; align-items: center; gap: 14px; }
  .header-icon {
    width: 40px; height: 40px; border-radius: 10px;
    background: rgba(41, 150, 204, 0.15); color: #2996cc;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; flex-shrink: 0;
  }
  .header-text { display: flex; flex-direction: column; min-width: 0; }
  .header-title-row { display: flex; align-items: center; gap: 8px; }
  .modal-title { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: -0.2px; }
  .modal-sub { font-size: 12px; color: #94a3b8; margin: 2px 0 0 0; }

  .device-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 500;
    background: rgba(34, 197, 94, 0.12); color: #16a34a;
    border: 1px solid rgba(34, 197, 94, 0.25);
  }
  .dark-theme .device-badge {
    background: rgba(34, 197, 94, 0.18); color: #4ade80;
    border-color: rgba(34, 197, 94, 0.35);
  }
  .pulse-dot-sm {
    width: 6px; height: 6px; border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7);
    animation: pulse 1.6s infinite;
  }

  .close-btn {
    background: transparent; border: none; cursor: pointer; color: #94a3b8;
    padding: 6px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
    transition: 0.15s;
  }
  .close-btn:hover { background: rgba(148, 163, 184, 0.15); color: inherit; }

  .modal-body {
    padding: 20px 24px;
    overflow-y: auto;
    flex: 1;
  }

  .loading-wrap {
    display: flex; flex-direction: column; align-items: center;
    padding: 40px; gap: 12px; color: #94a3b8;
  }
  .spinner {
    width: 28px; height: 28px;
    border: 3px solid rgba(148, 163, 184, 0.2);
    border-top-color: #3b82f6; border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-msg { color: #ef4444; font-size: 13px; padding: 10px 0; }

  /* Two-column dashboard grid */
  .settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    align-items: start;
  }
  .settings-col {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  /* Modern panel cards */
  .panel-card {
    background: rgba(148, 163, 184, 0.05);
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 12px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    transition: border-color 0.2s;
  }
  .light-theme .panel-card {
    background: #f8fafc;
    border-color: #e2e8f0;
  }
  .dark-theme .panel-card {
    background: rgba(255, 255, 255, 0.03);
    border-color: rgba(255, 255, 255, 0.08);
  }

  .panel-card.highlight-card {
    border-color: rgba(59, 130, 246, 0.28);
  }
  .dark-theme .panel-card.highlight-card {
    background: rgba(59, 130, 246, 0.03);
    border-color: rgba(59, 130, 246, 0.35);
  }
  .light-theme .panel-card.highlight-card {
    background: #f0f7ff;
    border-color: rgba(59, 130, 246, 0.28);
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .panel-title {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: #64748b;
  }
  .panel-title svg { color: #3b82f6; flex-shrink: 0; }
  .dark-theme .panel-title { color: #94a3b8; }

  .panel-content-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .readonly-panel {
    opacity: 0.85;
  }
  .readonly-fields-wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .subfields-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .service-disabled-notice {
    font-size: 12px;
    color: #94a3b8;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(148, 163, 184, 0.08);
    font-style: italic;
    text-align: center;
  }

  .check-update-btn {
    display: flex; align-items: center; gap: 5px;
    background: rgba(148, 163, 184, 0.12);
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 6px;
    padding: 3px 8px; font-size: 11px; font-weight: 500;
    color: inherit; cursor: pointer; transition: 0.15s;
  }
  .check-update-btn:hover:not(:disabled) { background: rgba(148, 163, 184, 0.22); }
  .check-update-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .version-row { display: flex; align-items: center; justify-content: space-between; padding: 2px 0; }
  .version-label { font-size: 13px; }
  .version-badge {
    font-size: 12px; font-family: monospace; font-weight: 600;
    padding: 2px 8px; border-radius: 6px;
    background: rgba(148, 163, 184, 0.15);
  }

  .update-banner {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-radius: 10px;
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, rgba(147, 51, 234, 0.15) 100%);
    border: 1px solid rgba(59, 130, 246, 0.35);
    margin-top: 2px;
  }
  .update-banner-info { display: flex; align-items: center; gap: 8px; }
  .pulse-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7);
    animation: pulse 1.6s infinite;
  }
  @keyframes pulse {
    0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
    70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
    100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
  }
  .update-banner-title { font-size: 12px; font-weight: 600; }
  .update-banner-ver { font-size: 11px; color: #3b82f6; font-weight: 600; }

  .update-now-btn {
    display: flex; align-items: center; gap: 4px;
    background: #3b82f6; color: white;
    border: none; border-radius: 6px;
    padding: 5px 10px; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: 0.15s;
  }
  .update-now-btn:hover:not(:disabled) { background: #2563eb; }
  .update-now-btn:disabled { opacity: 0.6; cursor: not-allowed; }

  .ota-status-msg {
    font-size: 12px; padding: 6px 10px; border-radius: 6px;
    background: rgba(239, 68, 68, 0.1); color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.2);
  }
  .ota-status-msg.success {
    background: rgba(34, 197, 94, 0.1); color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.2);
  }

  .spinner-sm {
    width: 12px; height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  .field-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 0;
  }
  .field-label { font-size: 13px; }

  .field-input { display: flex; flex-direction: column; gap: 4px; }
  .field-label-sm { font-size: 12px; color: #94a3b8; }
  .field-label-sm-row { display: flex; align-items: center; justify-content: space-between; }
  
  .copy-link-btn {
    background: none; border: none; color: #3b82f6; font-size: 11px;
    cursor: pointer; padding: 0; display: inline-flex; align-items: center; gap: 4px;
    font-family: inherit; font-weight: 500;
  }
  .copy-link-btn:hover { text-decoration: underline; }

  .refresh-link-btn {
    background: none; border: none; color: #3b82f6; font-size: 11px;
    cursor: pointer; padding: 0; display: inline-flex; align-items: center; gap: 4px;
    font-family: inherit;
  }
  .refresh-link-btn:hover { text-decoration: underline; }
  .refresh-link-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .text-input {
    padding: 8px 10px; border-radius: 8px; font-size: 13px;
    border: 1px solid rgba(148, 163, 184, 0.3);
    background-color: rgba(148, 163, 184, 0.08); color: inherit;
    outline: none; font-family: inherit;
    box-sizing: border-box;
    width: 100%;
  }
  .text-input:focus { border-color: #3b82f6; }
  .text-input.readonly { opacity: 0.75; cursor: default; font-family: monospace; font-size: 12px; }

  select.text-input,
  select.select-input {
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    padding: 8px 34px 8px 10px;
    background-repeat: no-repeat !important;
    background-position: right 10px center !important;
    background-size: 13px 13px !important;
    cursor: pointer;
    line-height: 1.4;
    box-sizing: border-box;
    width: 100%;
  }

  .dark-theme select.text-input,
  .dark-theme select.select-input {
    color-scheme: dark;
    background-color: #1a2328;
    color: #ffffff;
    border: 1px solid rgba(148, 163, 184, 0.3);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
    background-repeat: no-repeat !important;
    background-position: right 10px center !important;
    background-size: 13px 13px !important;
  }

  .light-theme select.text-input,
  .light-theme select.select-input {
    color-scheme: light;
    background-color: #ffffff;
    color: #101c22;
    border: 1px solid #cbd5e1;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
    background-repeat: no-repeat !important;
    background-position: right 10px center !important;
    background-size: 13px 13px !important;
  }

  .dark-theme select.text-input option,
  .dark-theme select.select-input option,
  .dark-theme select.text-input optgroup,
  .dark-theme select.select-input optgroup {
    background-color: #202a2f;
    color: #ffffff;
  }

  .light-theme select.text-input option,
  .light-theme select.select-input option,
  .light-theme select.text-input optgroup,
  .light-theme select.select-input optgroup {
    background-color: #ffffff;
    color: #101c22;
  }

  .token-input-wrap {
    display: flex; align-items: center; gap: 6px;
  }
  .token-input { flex: 1; min-width: 0; }
  .icon-btn {
    width: 32px; height: 32px; border-radius: 8px;
    border: 1px solid rgba(148,163,184,0.25);
    background: rgba(148,163,184,0.10);
    color: #64748b;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; flex-shrink: 0;
  }
  .icon-btn:hover { background: rgba(148,163,184,0.18); color: inherit; }
  .dark-theme .icon-btn { border-color: rgba(255,255,255,0.12); color: #94a3b8; }

  /* Toggle switch */
  .switch {
    position: relative; display: inline-block; width: 38px; height: 22px; flex-shrink: 0;
  }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(148, 163, 184, 0.3); border-radius: 22px; transition: 0.2s;
  }
  .slider::before {
    content: ""; position: absolute; height: 16px; width: 16px; left: 3px; bottom: 3px;
    background: white; border-radius: 50%; transition: 0.2s;
  }
  .switch input:checked + .slider { background: #3b82f6; }
  .switch input:checked + .slider::before { transform: translateX(16px); }

  .modal-footer {
    display: flex; gap: 10px; justify-content: flex-end;
    padding: 14px 24px;
    border-top: 1px solid rgba(148, 163, 184, 0.15);
  }
  .light-theme .modal-footer { border-top-color: #e2e8f0; }
  .dark-theme .modal-footer { border-top-color: #334155; }

  .btn {
    padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 500;
    border: none; cursor: pointer; transition: 0.15s;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { background: rgba(148, 163, 184, 0.15); color: inherit; }
  .btn-secondary:hover:not(:disabled) { background: rgba(148, 163, 184, 0.25); }
  .btn-primary { background: #3b82f6; color: white; }
  .btn-primary:hover:not(:disabled) { background: #2563eb; }

  /* Mobile responsiveness */
  @media (max-width: 768px) {
    .modal-backdrop {
      padding: 10px;
    }
    .modal-card {
      max-width: 100%;
      max-height: 94vh;
    }
    .modal-header {
      padding: 14px 16px;
    }
    .modal-body {
      padding: 14px 16px;
    }
    .settings-grid {
      grid-template-columns: 1fr;
      gap: 12px;
    }
    .modal-footer {
      padding: 12px 16px;
    }
  }
</style>
