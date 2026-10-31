<script>
  import { createEventDispatcher, onMount, onDestroy, tick } from "svelte";
  import { fly, fade } from "svelte/transition";
  import { _ } from "../lib/i18n/index.js";
  import lightGallery from "lightgallery";
  import { setupGalleryPagination, isJustFileName } from "../lib/gallery-pagination.js";
  import FolderPicker from "./FolderPicker.svelte";
  import { deviceRegistry } from "../lib/device-registry.js";
  import { profileStore } from "../lib/profile-store.js";
  import {
    parseStoragePath,
    DEFAULT_STORAGE_PATH,
    getLocalDevice
  } from "../lib/storage-path.js";
  import { issueConsent, getClientDeviceServer } from "../lib/client-device-server.js";
  import { getOrCreateLocalLinkId } from "../lib/local-client.js";
  import { mcpKeysStore, getMcpPayload } from "../lib/mcp-keys.js";
  import defaultKreaPresets from "../lib/krea_presets.json";

  $: hasCivitaiToken = Boolean($mcpKeysStore && $mcpKeysStore.byApp && $mcpKeysStore.byApp.civitai && $mcpKeysStore.byApp.civitai.key);

  export let httpDrive = null;
  export let deviceDrive = null;
  export let targetDevice = null;
  export let targetLinkId = "";
  export let isPrivateMode = false;
  export let omdKey = "";
  export let chatStore = null;
  export let isDarkTheme = true;
  export let contentMode = "work";
  export let isOverlayHeader = false;
  export let sidebarOpen = true;
  export let defaultStorage = "";
  export let userName = "";
  export let kreaSupported = true;

  const dispatch = createEventDispatcher();

  let innerWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  $: isMobile = innerWidth < 768;

  // Active top tab: 'gallery' | 'personas'
  let activeTab = "gallery";

  // Gallery items & Personas
  let items = [];

  let sortOrder = typeof localStorage !== "undefined"
    ? localStorage.getItem("omd_krea_sort") || localStorage.getItem("omd_creations_sort") || "desc"
    : "desc"; // 'desc' (newest first) | 'asc' (oldest first)

  function getItemTimestamp(item) {
    if (!item) return 0;
    const name = item.name || item.id || "";
    // 1. Try YYYYMMDD_HHMMSS (e.g. KREA_00001_20261015_145535.png, IMG_00001_20261013_081139.png)
    const matchYmdHms = name.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (matchYmdHms) {
      const [_, y, m, d, h, min, s] = matchYmdHms;
      const parsedTime = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(min, 10), parseInt(s, 10)).getTime();
      if (!isNaN(parsedTime)) return parsedTime;
    }
    // 2. Try 13-digit Unix ms timestamp (e.g. krea_1729000000000.png)
    const match13 = name.match(/_(\d{13})/);
    if (match13) {
      const parsedTime = parseInt(match13[1], 10);
      if (!isNaN(parsedTime)) return parsedTime;
    }
    // 3. Try item.date
    if (item.date instanceof Date) {
      const t = item.date.getTime();
      if (!isNaN(t) && t > 0) return t;
    } else if (typeof item.date === "number" && !isNaN(item.date) && item.date > 0) {
      return item.date;
    } else if (item.date) {
      const t = new Date(item.date).getTime();
      if (!isNaN(t) && t > 0) return t;
    }
    return 0;
  }

  function sortItemsList(list, order = sortOrder) {
    return [...list].sort((a, b) => {
      const timeA = getItemTimestamp(a);
      const timeB = getItemTimestamp(b);
      if (timeA !== timeB) {
        return order === "desc" ? timeB - timeA : timeA - timeB;
      }
      return order === "desc"
        ? (b.name || "").localeCompare(a.name || "")
        : (a.name || "").localeCompare(b.name || "");
    });
  }

  async function toggleSortOrder() {
    sortOrder = sortOrder === "desc" ? "asc" : "desc";
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("omd_krea_sort", sortOrder);
      localStorage.setItem("omd_creations_sort", sortOrder);
    }
    items = sortItemsList(items, sortOrder);
    await tick();
    initLightGallery();
  }

  const SELECTED_PERSONAS_KEY = "krea_selected_personas";

  function getLocalSelectedPersonas(currentPersonas) {
    if (typeof localStorage === "undefined") return [];
    try {
      const raw = localStorage.getItem(SELECTED_PERSONAS_KEY);
      if (raw) {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) {
          return (currentPersonas || []).filter((p) => ids.includes(p.id));
        }
      }
    } catch (_) {}
    return [];
  }

  function saveLocalSelectedPersonas(selectedList) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        SELECTED_PERSONAS_KEY,
        JSON.stringify((selectedList || []).map((p) => p.id))
      );
    } catch (_) {}
  }

  let personas = [];
  let selectedPersonas = [];
  $: selectedPersona = selectedPersonas[0] || null;

  $: if (typeof localStorage !== "undefined" && selectedPersonas) {
    saveLocalSelectedPersonas(selectedPersonas);
  }
  let isLoadingFiles = false;
  let isGenerating = false;
  let generationElapsed = 0;
  let generationTimer = null;
  let generatingPrompt = "";
  let generatingPersona = "";
  let generatingStage = "generating"; // "warming" | "generating" | "saving"
  let isGpuWarm = false;
  let lastGenFinishedAt = 0;
  let isRandomizingPrompt = false;

  const KREA_SLIDERS_KEY = "krea_studio_sliders_v1";

  function getLocalSliders() {
    try {
      let raw = null;
      if (typeof localStorage !== "undefined") {
        raw = localStorage.getItem(KREA_SLIDERS_KEY);
      }
      if (!raw && typeof sessionStorage !== "undefined") {
        raw = sessionStorage.getItem(KREA_SLIDERS_KEY);
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        console.log("[KreaStudio] Restored sliders from storage:", parsed);
        return parsed;
      }
    } catch (err) {
      console.warn("[KreaStudio] Failed to read sliders from storage:", err);
    }
    return null;
  }

  function saveLocalSliders(s) {
    if (!s) return;
    try {
      const activeStyles = Array.isArray(s.styles) ? s.styles.filter((x) => x && x !== "none") : [];
      const primaryStyle = activeStyles.length > 0 ? activeStyles[0] : "none";
      const activeArchetypes = Array.isArray(s.archetypes) ? s.archetypes.filter(Boolean) : [];
      const primaryArchetype = activeArchetypes.length > 0 ? activeArchetypes[0] : null;

      const cleanedStyleWeights = {};
      for (const stId of activeStyles) {
        if (s.style_weights?.[stId] !== undefined) {
          cleanedStyleWeights[stId] = s.style_weights[stId];
        }
      }
      const cleanedArchetypeWeights = {};
      for (const aId of activeArchetypes) {
        if (s.archetype_weights?.[aId] !== undefined) {
          cleanedArchetypeWeights[aId] = s.archetype_weights[aId];
        }
      }

      const payload = {
        base_model: s.base_model || "anima",
        detail: typeof s.detail === "number" ? s.detail : 0.5,
        styles: activeStyles,
        style_weights: cleanedStyleWeights,
        style: primaryStyle,
        style_strength: typeof s.style_strength === "number" ? s.style_strength : 0.8,
        archetypes: activeArchetypes,
        archetype_weights: cleanedArchetypeWeights,
        archetype: primaryArchetype,
        archetype_strength: typeof s.archetype_strength === "number" ? s.archetype_strength : 0.4,
        aspect: s.aspect || "896x1152",
        steps: typeof s.steps === "number" ? s.steps : (s.base_model === "realism" ? 14 : (s.base_model === "semi_realism" ? 16 : 25)),
        cfg: typeof s.cfg === "number" ? s.cfg : (s.base_model === "realism" ? 1.5 : (s.base_model === "semi_realism" ? 2.0 : 3.0))
      };
      const jsonStr = JSON.stringify(payload);

      let saved = false;
      if (typeof localStorage !== "undefined") {
        try {
          localStorage.removeItem(KREA_SLIDERS_KEY);
          localStorage.setItem(KREA_SLIDERS_KEY, jsonStr);
          saved = true;
        } catch (lsErr) {
          console.warn("[KreaStudio] localStorage.setItem failed (quota exceeded?), falling back to sessionStorage:", lsErr);
        }
      }

      if (typeof sessionStorage !== "undefined") {
        try {
          sessionStorage.setItem(KREA_SLIDERS_KEY, jsonStr);
          saved = true;
        } catch (_) {}
      }

      if (saved) {
        console.log("[KreaStudio] Saved sliders to storage:", payload);
      }
    } catch (err) {
      console.warn("[KreaStudio] Failed to save sliders to storage:", err);
    }
  }

  function closeStyleDropdown() {
    showStyleDropdown = false;
    sliders.styles = Array.isArray(sliders.styles) ? sliders.styles.filter((x) => x && x !== "none") : [];
    sliders.style = sliders.styles[0] || "none";
    if (sliders.styles.length > 0 && sliders.style_weights?.[sliders.style]) {
      sliders.style_strength = sliders.style_weights[sliders.style];
    }
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  function closeArchetypeDropdown() {
    showArchetypeDropdown = false;
    sliders.archetypes = Array.isArray(sliders.archetypes) ? sliders.archetypes.filter(Boolean) : [];
    sliders.archetype = sliders.archetypes[0] || null;
    if (sliders.archetypes.length > 0 && sliders.archetype_weights?.[sliders.archetype]) {
      sliders.archetype_strength = sliders.archetype_weights[sliders.archetype];
    }
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  const initialSavedSliders = getLocalSliders();
  const initStyles = (initialSavedSliders && Array.isArray(initialSavedSliders.styles))
    ? initialSavedSliders.styles.filter((x) => x && x !== "none")
    : ((initialSavedSliders && initialSavedSliders.style && initialSavedSliders.style !== "none") ? [initialSavedSliders.style] : []);
  const initPrimaryStyle = initStyles.length > 0 ? initStyles[0] : "none";

  const initArchetypes = (initialSavedSliders && Array.isArray(initialSavedSliders.archetypes))
    ? initialSavedSliders.archetypes.filter(Boolean)
    : ((initialSavedSliders && initialSavedSliders.archetype) ? [initialSavedSliders.archetype] : []);
  const initPrimaryArchetype = initArchetypes.length > 0 ? initArchetypes[0] : null;

  const initBaseModel = (initialSavedSliders && initialSavedSliders.base_model) || "anima";

  // Sliders state (restored from localStorage if available)
  let sliders = {
    base_model: initBaseModel,
    detail: (initialSavedSliders && typeof initialSavedSliders.detail === "number") ? initialSavedSliders.detail : 0.5,
    styles: initStyles,
    style_weights: (initialSavedSliders && typeof initialSavedSliders.style_weights === "object" && initialSavedSliders.style_weights) ? initialSavedSliders.style_weights : {},
    style: initPrimaryStyle,
    style_strength: (initialSavedSliders && typeof initialSavedSliders.style_strength === "number") ? initialSavedSliders.style_strength : 0.8,
    archetypes: initArchetypes,
    archetype_weights: (initialSavedSliders && typeof initialSavedSliders.archetype_weights === "object" && initialSavedSliders.archetype_weights) ? initialSavedSliders.archetype_weights : {},
    archetype: initPrimaryArchetype,
    archetype_strength: (initialSavedSliders && typeof initialSavedSliders.archetype_strength === "number") ? initialSavedSliders.archetype_strength : 0.4,
    aspect: (initialSavedSliders && initialSavedSliders.aspect) || "896x1152",
    steps: (initialSavedSliders && typeof initialSavedSliders.steps === "number") ? initialSavedSliders.steps : (initBaseModel === "realism" ? 14 : (initBaseModel === "semi_realism" ? 16 : 25)),
    cfg: (initialSavedSliders && typeof initialSavedSliders.cfg === "number") ? initialSavedSliders.cfg : (initBaseModel === "realism" ? 1.5 : (initBaseModel === "semi_realism" ? 2.0 : 3.0))
  };

  function setBaseModel(model) {
    if (sliders.base_model === model) return;
    sliders.base_model = model;
    if (model === "realism") {
      sliders.cfg = 1.5;
      sliders.steps = 14;
    } else if (model === "semi_realism") {
      sliders.cfg = 2.0;
      sliders.steps = 16;
    } else {
      sliders.cfg = 3.0;
      sliders.steps = 25;
    }
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  function setAspect(aspect) {
    sliders.aspect = aspect;
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  $: if (typeof localStorage !== "undefined" && sliders) {
    saveLocalSliders(sliders);
  }

  let showSlidersPanel = true;
  let showPromptTokensPreview = false;
  let showStyleDropdown = false;
  let showArchetypeDropdown = false;
  let showAdvancedSettings = false;

  function closeAdvancedSettings() {
    showAdvancedSettings = false;
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  function resetAdvancedToModelDefaults() {
    if (sliders.base_model === "realism") {
      sliders.cfg = 1.5;
      sliders.steps = 14;
    } else if (sliders.base_model === "semi_realism") {
      sliders.cfg = 2.0;
      sliders.steps = 16;
    } else {
      sliders.cfg = 3.0;
      sliders.steps = 25;
    }
    sliders.detail = 0.5;
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  // 1. Art Styles & Archetypes from unified registry krea_presets.json
  let kreaPresets = defaultKreaPresets;

  $: currentBaseCategory = sliders.base_model === "anima" ? "anima" : "krea2";

  $: filteredArtStyles = (kreaPresets.art_styles || []).filter((s) => {
    if (!s.models || s.models.includes("all")) return true;
    return s.models.includes(currentBaseCategory);
  });

  $: stylePresets = filteredArtStyles.map((s) => ({
    id: s.id,
    label: (s.icon ? s.icon + " " : "") + (s.id === "none" ? $_("krea_style_none", {}, s.name) : s.name),
    name: s.id === "none" ? $_("krea_style_none", {}, s.name) : s.name,
    desc: s.id === "none" ? $_("krea_style_none_desc", {}, s.description) : s.description,
    trigger: s.trigger,
    lora: s.filename,
    strength: s.strength
  }));

  $: filteredArchetypes = (kreaPresets.archetypes || []).filter((a) => {
    if (!a.models || a.models.includes("all")) return true;
    return a.models.includes(currentBaseCategory);
  });

  $: archetypePresets = filteredArchetypes.map((a) => ({
    id: a.id,
    label: (a.icon ? a.icon + " " : "") + a.name,
    name: a.name,
    desc: a.description,
    trigger: a.trigger,
    lora: a.filename,
    strength: a.strength
  }));

  // Auto-validate selections when base model changes
  let prevBaseModel = sliders.base_model;
  $: if (sliders.base_model !== prevBaseModel) {
    prevBaseModel = sliders.base_model;
    const cat = sliders.base_model === "anima" ? "anima" : "krea2";
    const availableStyles = (kreaPresets.art_styles || [])
      .filter((s) => !s.models || s.models.includes("all") || s.models.includes(cat))
      .map((s) => s.id);
    const availableArchetypes = (kreaPresets.archetypes || [])
      .filter((a) => !a.models || a.models.includes("all") || a.models.includes(cat))
      .map((a) => a.id);

    let changed = false;
    if (sliders.styles && sliders.styles.length > 0) {
      const filtered = sliders.styles.filter((id) => availableStyles.includes(id));
      if (filtered.length !== sliders.styles.length) {
        sliders.styles = filtered;
        sliders.style = sliders.styles[0] || "none";
        changed = true;
      }
    }
    if (sliders.archetypes && sliders.archetypes.length > 0) {
      const filtered = sliders.archetypes.filter((id) => availableArchetypes.includes(id));
      if (filtered.length !== sliders.archetypes.length) {
        sliders.archetypes = filtered;
        sliders.archetype = sliders.archetypes[0] || null;
        changed = true;
      }
    }
    if (changed) {
      sliders = { ...sliders };
      saveLocalSliders(sliders);
    }
  }

  $: activeStyleObjs = stylePresets.filter((s) => (sliders.styles || []).includes(s.id));
  $: activeStyleObj = activeStyleObjs[0] || stylePresets.find((s) => s.id === sliders.style) || stylePresets[0] || { label: "✨ " + $_("krea_free_style", {}, "Свободный"), lora: "" };
  $: activeStyleLabel = (() => {
    const list = (sliders.styles || []).filter((id) => id !== "none");
    if (list.length === 0) return "✨ " + $_("krea_free_style", {}, "Свободный");
    if (list.length === 1) {
      const s = activeStyleObjs[0];
      const w = sliders.style_weights?.[s?.id] ?? s?.strength;
      return s ? `${s.name}${w !== undefined ? ` (${w})` : ""}` : $_("krea_1_style", {}, "1 стиль");
    }
    if (list.length === 2) {
      const s1 = activeStyleObjs[0];
      const s2 = activeStyleObjs[1];
      const w1 = sliders.style_weights?.[s1?.id] ?? s1?.strength;
      const w2 = sliders.style_weights?.[s2?.id] ?? s2?.strength;
      return `${s1?.name || "1"}${w1 !== undefined ? ` (${w1})` : ""}, ${s2?.name || "2"}${w2 !== undefined ? ` (${w2})` : ""}`;
    }
    return `${activeStyleObjs[0]?.name || $_("krea_style_label", {}, "Стиль")} +${list.length - 1} (${list.length})`;
  })();

  $: activeArchetypeObjs = archetypePresets.filter((a) => (sliders.archetypes || []).includes(a.id));
  $: activeArchetypeObj = activeArchetypeObjs[0] || null;
  $: activeArchetypeLabel = (() => {
    const list = sliders.archetypes || [];
    if (list.length === 0) return "✨ " + $_("krea_free_style", {}, "Свободный");
    if (list.length === 1) {
      const a = activeArchetypeObjs[0];
      const w = sliders.archetype_weights?.[a?.id] ?? a?.strength;
      return a ? `${a.name}${w !== undefined ? ` (${w})` : ""}` : $_("krea_1_archetype", {}, "1 типаж");
    }
    if (list.length === 2) {
      const a1 = activeArchetypeObjs[0];
      const a2 = activeArchetypeObjs[1];
      const w1 = sliders.archetype_weights?.[a1?.id] ?? a1?.strength;
      const w2 = sliders.archetype_weights?.[a2?.id] ?? a2?.strength;
      return `${a1?.name || "1"}${w1 !== undefined ? ` (${w1})` : ""}, ${a2?.name || "2"}${w2 !== undefined ? ` (${w2})` : ""}`;
    }
    return `${activeArchetypeObjs[0]?.name || $_("krea_archetype_label", {}, "Типаж")} +${list.length - 1} (${list.length})`;
  })();

  function getArchetypeToken(id) {
    const ap = archetypePresets.find((a) => a.id === id);
    if (!ap) return "";
    const weight = sliders.archetype_weights?.[id] ?? ap.strength ?? 0.8;
    const loraPart = ap.lora ? `LoRA: ${ap.lora.replace('.safetensors', '')} (${weight}) + ` : "";
    return `${loraPart}${ap.trigger || ""}`;
  }

  function getStyleToken(id) {
    const sp = stylePresets.find((s) => s.id === id);
    if (!sp || !sp.trigger) return "";
    const weight = sliders.style_weights?.[id] ?? sp.strength ?? 0.8;
    const loraPart = sp.lora ? `LoRA: ${sp.lora.replace('.safetensors', '')} (${weight}) + ` : "";
    return `${loraPart}${sp.trigger || ""}`;
  }

  $: activeStyleTokens = activeStyleObjs
    .map((sp) => getStyleToken(sp.id))
    .filter(Boolean)
    .join(" | ");

  $: activeArchetypeTokens = activeArchetypeObjs
    .map((ap) => getArchetypeToken(ap.id))
    .filter(Boolean)
    .join(" | ");

  // Prompt & Auto-resize
  let promptText = "";
  let textareaEl = null;

  // Reference Images (max 2)
  let attachedReferences = []; // [{ id, name, path, preview, dataUrl }]
  let refFileInputEl = null;
  let isUploadingRef = false;

  // Prompt History
  let showPromptsPopup = false;
  let promptsSearchQuery = "";
  let recentPrompts = [];
  let unsubPrompts = null;

  $: filteredPrompts = recentPrompts
    .filter((p) => {
      if (!promptsSearchQuery.trim()) return true;
      const q = promptsSearchQuery.toLowerCase();
      const txt = (typeof p === "string" ? p : p.text || p.prompt || "").toLowerCase();
      const st = (p.style || "").toLowerCase();
      return txt.includes(q) || st.includes(q);
    })
    .sort((a, b) => {
      const ta = new Date(a.lastUsed || a.created || a.date || 0).getTime();
      const tb = new Date(b.lastUsed || b.created || b.date || 0).getTime();
      return tb - ta;
    });

  function resizeTextarea() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    const minH = 40;
    const maxH = 125;
    const scrollH = textareaEl.scrollHeight;
    if (!promptText || !promptText.trim()) {
      textareaEl.style.height = minH + "px";
      textareaEl.style.overflowY = "hidden";
      return;
    }
    const newH = Math.min(Math.max(scrollH, minH), maxH);
    textareaEl.style.height = `${newH}px`;
    textareaEl.style.overflowY = scrollH > maxH ? "auto" : "hidden";
  }

  // Storage resolution
  let showFolderPicker = false;
  let showStorageSourceChooser = false;
  let storageSources = [];
  let storagePickerDevice = null;
  let foundDevice = null;

  // Persona Modal (create / edit manually)
  let showPersonaModal = false;
  let editingPersonaId = null;
  let personaFormName = "";
  let personaFormTitle = "";
  let personaFormPrompt = "";
  let personaFormAvatarData = "";
  let personaFormAvatarPreview = "";
  let isSavingPersona = false;
  let isGeneratingAvatar = false;
  let isAnalyzingFace = false;
  let avatarGenArchetype = "prompt";

  // AI Persona Factory Modal (Scenario A + Scenario B combined)
  let showAiFactoryModal = false;
  let aiFactoryArchetype = "alt";
  let isGeneratingAiPersona = false;
  let generatedAiPersona = null;
  // Confirmation Modal state
  let deleteConfirmTarget = null;
  let isDeletingItem = false;
  $: aiArchetypes = (kreaPresets.archetypes || []).map((a) => ({
    id: a.id,
    name: (a.icon ? a.icon + " " : "") + a.name,
    rawName: a.name,
    title: a.title || `${a.name} / ${a.description}`,
    hint: a.description + (a.filename ? " (LoRA)" : ""),
    trigger: a.trigger || "",
    icon: a.icon || "👤",
    lora: a.filename || ""
  }));
  $: if (!aiFactoryArchetype && aiArchetypes.length > 0) {
    aiFactoryArchetype = aiArchetypes[0].id;
  }

  // Dynamic Scene & Action Generator (combines vivid action, emotion, lighting, and camera angle)
  const dynamicActionScenes = [
    "running dynamically through a neon-lit rain-soaked alleyway, coat billowing, wet asphalt reflections",
    "adjusting dark sunglasses while leaning against a vintage sports car, wind blowing hair, golden sunset light",
    "sipping steaming espresso on a foggy morning Parisian balcony at sunrise, intimate mood, soft bokeh",
    "confidently leaping across city rooftops under a glowing moon, mid-air freeze frame, dynamic action pose",
    "laughing candidly at an outdoor summer music festival, warm sun flare, colorful confetti falling around",
    "crouching behind a concrete column in a high-tech data center, holding a tactical scanner, suspenseful atmosphere",
    "vibing with vintage over-ear headphones in an atmospheric vinyl record shop, warm retro tungsten lighting",
    "walking briskly through a crowded Tokyo Shibuya crossing at twilight, transparent umbrella, city motion blur",
    "drawing a ceremonial katana in a blossom-filled garden, sakura petals swirling in the gust of wind, dynamic stance",
    "relaxing on a deep emerald velvet lounge couch under warm amber lamps, looking over shoulder with an enigmatic smirk",
    "riding a sleek cafe racer motorcycle down an empty coastal highway at golden hour, hair flying in the sea breeze",
    "stepping out of a vintage yellow cab into rainy downtown Manhattan, steam rising from underground subway grates",
    "dancing under moody laser lights in an underground warehouse venue, subtle motion trails, electric atmosphere",
    "inspecting an antique camera at a sun-drenched wooden workbench, dust motes floating in sunbeams",
    "standing on an open rooftop helipad overlooking a vast futuristic metropolis skyline, strong wind blowing scarf"
  ];

  const dynamicCameraAngles = [
    "cinematic Dutch angle shot, intense dynamic composition, shallow depth of field",
    "low-angle heroic perspective, wide-angle 24mm lens, dramatic cinematic scale",
    "over-the-shoulder tracking perspective, anamorphic lens flare, motion blur",
    "cinematic eye-level candid medium shot, 50mm f/1.4 lens, creamy soft bokeh",
    "dynamic three-quarter action angle, sharp foreground focus, diagonal cinematic lines",
    "atmospheric high-angle establishing shot, cinematic framing, moody cinematic lighting"
  ];

  // LightGallery & Blob Cache
  let scrollContainerEl;
  let lgInstance = null;
  let lgPagination = null;
  let copiedPromptId = null;
  let imageBlobCache = {};

  // Prompt suggestions for empty gallery state
  const promptSuggestions = [
    "cinematic street portrait in rainy Tokyo, neon bokeh reflections, 35mm film",
    "candid cafe portrait, soft morning window light, delicate details, 8k raw photo",
    "dramatic moody editorial in vintage suit, chiaroscuro lighting, studio photography",
    "cyberpunk nighttime skyline, misty atmospheric lighting, ultra-high resolution"
  ];

  function resolveDevice() {
    const raw = (
      defaultStorage ||
      (typeof localStorage !== "undefined" ? localStorage.getItem("omd_default_storage") : "") ||
      (typeof window !== "undefined" && window.__omdProfile?.defaultStorage) ||
      ""
    ).trim();
    const parsed = parseStoragePath(raw);
    if (parsed.device && !parsed.device.isAiNode) return parsed.device;
    if (parsed.deviceName && parsed.deviceName.toLowerCase() !== "local") {
      const match = deviceRegistry.list().find(
        (d) => d && (
          (d.name && d.name.toLowerCase() === parsed.deviceName.toLowerCase()) ||
          (d.linkId && d.linkId.toLowerCase() === parsed.deviceName.toLowerCase())
        )
      );
      if (match && !match.isAiNode) return match;
    }
    if (targetDevice && !targetDevice.isAiNode) return targetDevice;
    if (targetLinkId) {
      const d = deviceRegistry.get(targetLinkId) || deviceRegistry.getByPrefix(targetLinkId) || deviceRegistry.getByName(targetLinkId);
      if (d && !d.isAiNode) return d;
    }
    if (deviceDrive) {
      const d = deviceRegistry.list().find((x) => x.drive === deviceDrive && !x.isAiNode);
      if (d) return d;
    }
    const local = getLocalDevice();
    if (local) return local;
    return (
      deviceRegistry.list().find((d) => !d.isAiNode) ||
      null
    );
  }

  function getTargetDrive() {
    const resDev = resolveDevice();
    return (
      resDev?.drive ||
      deviceDrive ||
      targetDevice?.drive ||
      (typeof window !== "undefined" && window.currentP2PDrive) ||
      null
    );
  }

  let driveCleanup = null;
  let lastDriveInstance = null;
  let lastDriveConnected = false;
  let lastStoragePath = "";

  $: if (deviceDrive) {
    if (driveCleanup) {
      driveCleanup();
      driveCleanup = null;
    }
    const onStatus = (st) => {
      if (st === "connected") {
        loadCreations();
        loadPersonas();
      }
    };
    if (typeof deviceDrive.addStatusListener === "function") {
      deviceDrive.addStatusListener(onStatus);
      driveCleanup = () => {
        if (typeof deviceDrive.removeStatusListener === "function") {
          deviceDrive.removeStatusListener(onStatus);
        }
      };
    } else if (typeof deviceDrive.onStatusChange === "function") {
      const prev = deviceDrive.onStatusChange;
      deviceDrive.onStatusChange = (st) => {
        try { prev(st); } catch (_) {}
        onStatus(st);
      };
      driveCleanup = () => {
        deviceDrive.onStatusChange = prev;
      };
    }
  }

  $: {
    const isConn = !!(deviceDrive && (deviceDrive.isConnected || deviceDrive.status === "connected"));
    const curStorage = defaultStorage || "";
    if (
      deviceDrive !== lastDriveInstance ||
      isConn !== lastDriveConnected ||
      curStorage !== lastStoragePath
    ) {
      lastDriveInstance = deviceDrive;
      lastDriveConnected = isConn;
      lastStoragePath = curStorage;
      foundDevice = null;
      items = [];
      imageBlobCache = {};
      if (isConn || isPrivateMode || curStorage) {
        loadCreations();
        loadPersonas();
      }
    }
  }

  async function ensureFolderRecursive(drive, folder) {
    if (!drive) return;
    try {
      if (typeof drive.issueConsent === "function") {
        await drive.issueConsent(folder, { writable: true }).catch(() => {});
      }
      const parts = folder.split("/").filter(Boolean);
      let cur = "";
      for (const seg of parts) {
        cur += "/" + seg;
        if (typeof drive.homeMkDir === "function") {
          await drive.homeMkDir(cur).catch(() => {});
        } else if (typeof drive.mkDir === "function") {
          await drive.mkDir(cur).catch(() => {});
        } else if (typeof drive.mkdir === "function") {
          await drive.mkdir(cur).catch(() => {});
        }
      }
    } catch (_) {}
  }

  const ensureFolder = ensureFolderRecursive;

  async function writeDriveFile(drive, filePath, b64Data) {
    if (!drive || !filePath) return;
    try {
      if (typeof drive.writeFileChunked === "function") {
        await drive.writeFileChunked(filePath, b64Data, 32768);
      } else if (typeof drive.homeWrite === "function") {
        await drive.homeWrite(filePath, b64Data);
      } else if (typeof drive.putFile === "function") {
        await drive.putFile(filePath, b64Data, { encoding: "base64" });
      }
    } catch (e) {
      console.warn("[KreaStudio] writeDriveFile failed:", filePath, e);
    }
  }

  async function writeDriveText(drive, filePath, text) {
    if (!drive || !filePath) return;
    try {
      const b64 = btoa(unescape(encodeURIComponent(text)));
      await writeDriveFile(drive, filePath, b64);
    } catch (e) {
      console.warn("[KreaStudio] writeDriveText failed:", filePath, e);
    }
  }

  async function readDriveText(drive, filePath) {
    if (!drive || !filePath) return null;
    try {
      if (typeof drive.getFileContent === "function") {
        const blob = await drive.getFileContent(filePath);
        if (blob && typeof blob.text === "function") {
          return await blob.text();
        }
      } else if (typeof drive.getFile === "function") {
        const c = await drive.getFile(filePath);
        return typeof c === "string" ? c : JSON.stringify(c);
      }
    } catch (_) {}
    return null;
  }

  async function readDriveBlobAsDataUrl(drive, filePath) {
    if (!drive || !filePath) return null;
    try {
      if (typeof drive.getFileContent === "function") {
        const blob = await drive.getFileContent(filePath);
        if (blob && blob.size > 0) {
          return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result || null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        }
      }
    } catch (_) {}
    return null;
  }

  function getBaseStorage() {
    let raw = (
      defaultStorage ||
      (typeof localStorage !== "undefined" ? localStorage.getItem("omd_default_storage") : "") ||
      (typeof window !== "undefined" && window.__omdProfile?.defaultStorage) ||
      DEFAULT_STORAGE_PATH ||
      "/OnMyChat"
    ).trim();

    const parsed = (parseStoragePath && parseStoragePath(raw)) || {};
    let clean = (parsed.folder || parsed.subpath || raw || "").replace(/^\/+|\/+$/g, "");

    const knownUsers = [
      userName,
      typeof window !== "undefined" && window.__omdProfile?.user,
      typeof window !== "undefined" && window.__omdProfile?.name
    ].filter(Boolean);

    for (const u of knownUsers) {
      const uLower = u.toLowerCase();
      if (clean.toLowerCase() === uLower) {
        clean = (DEFAULT_STORAGE_PATH || "/OnMyChat").replace(/^\/+/, "");
        break;
      } else if (clean.toLowerCase().startsWith(uLower + "/")) {
        clean = clean.slice(u.length).replace(/^\/+/, "");
      }
    }

    clean = clean.replace(/^(home|Users)\/[^\/]+(\/|$)/i, "").replace(/^\/+|\/+$/g, "");
    clean = clean.replace(/^private\//i, "");
    if (clean.endsWith("/generated")) {
      clean = clean.slice(0, -"/generated".length);
    } else if (clean.endsWith("generated")) {
      clean = clean.slice(0, -"generated".length);
    }
    clean = clean.replace(/^\/+|\/+$/g, "");

    if (!clean) {
      clean = (DEFAULT_STORAGE_PATH || "/OnMyChat").replace(/^\/+/, "");
    }
    return clean || "OnMyChat";
  }

  function getTargetFolder() {
    const base = getBaseStorage();
    return `/${base}/generated`;
  }

  function getPersonasFolder() {
    const base = getBaseStorage();
    return `/${base}/personas`;
  }

  function getUploadFolder() {
    const base = getBaseStorage();
    return `/${base}/upload`;
  }

  async function handleRefFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (attachedReferences.length >= 2) {
      alert($_("krea_err_max_refs", {}, "Максимум 2 референса (Картинка 1 и Картинка 2)."));
      return;
    }
    isUploadingRef = true;
    try {
      const reader = new FileReader();
      const rawDataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const dataUrl = await downscaleImage(rawDataUrl, 1024);
      const cleanName = `ref_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const uploadFolder = getUploadFolder();
      const drive = getTargetDrive();
      if (drive && (drive.isConnected || drive.status === "connected")) {
        try {
          await ensureFolderRecursive(drive, uploadFolder);
          const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
          await writeDriveFile(drive, `${uploadFolder}/${cleanName}`, b64);
        } catch (err) {
          console.warn("[KreaStudio] Error saving uploaded ref to drive:", err);
        }
      }
      attachedReferences = [
        ...attachedReferences,
        {
          id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          path: `${uploadFolder}/${cleanName}`,
          preview: dataUrl,
          dataUrl: dataUrl
        }
      ];
    } catch (err) {
      console.error("[KreaStudio] Error reading reference image:", err);
      alert($_("krea_err_load_ref", { error: err.message }, `Ошибка загрузки референса: ${err.message}`));
    } finally {
      isUploadingRef = false;
      if (e.target) e.target.value = "";
    }
  }

  function removeReference(idx) {
    attachedReferences = attachedReferences.filter((_, i) => i !== idx);
  }

  async function addGalleryItemAsReference(item) {
    if (attachedReferences.length >= 2) {
      alert($_("krea_err_max_attached", {}, "Уже прикреплено максимум 2 референса. Удалите один, чтобы добавить этот."));
      return;
    }
    const name = item.title || item.name || "Gallery image";
    let dataUrl = "";
    const drive = getTargetDrive();
    if (item.path && drive && (drive.isConnected || drive.status === "connected")) {
      try {
        dataUrl = await readDriveBlobAsDataUrl(drive, item.path);
      } catch (_) {}
    }
    if (!dataUrl) {
      const fullUrl = getFullImageUrl(item);
      try {
        const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
          ? (p, opts) => httpDrive.fetch(p, opts)
          : (p, opts) => fetch(p, opts);
        const res = await fetchFn(fullUrl);
        if (res.ok) {
          const blob = await res.blob();
          const reader = new FileReader();
          dataUrl = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
      } catch (_) {}
    }
    if (!dataUrl) {
      dataUrl = getFullImageUrl(item);
    }
    attachedReferences = [
      ...attachedReferences,
      {
        id: `ref_gallery_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        path: item.path || "",
        preview: dataUrl,
        dataUrl: dataUrl
      }
    ];
  }

  $: displayFolder = getTargetFolder();

  function selectPersona(p) {
    if (selectedPersonas.some((x) => x.id === p.id)) {
      selectedPersonas = selectedPersonas.filter((x) => x.id !== p.id);
    } else {
      selectedPersonas = [...selectedPersonas, p];
    }
  }

  function removeSelectedPersona(pId) {
    selectedPersonas = selectedPersonas.filter((x) => x.id !== pId);
  }

  function toggleStyle(id, multi = false) {
    if (!sliders.styles) sliders.styles = [];
    if (!sliders.style_weights) sliders.style_weights = {};

    if (!multi) {
      if (sliders.styles.length === 1 && sliders.styles[0] === id) {
        sliders.styles = [];
        sliders.style = "none";
        sliders.style_weights = {};
      } else {
        sliders.styles = [id];
        sliders.style = id;
        const sp = stylePresets.find((s) => s.id === id);
        const str = sp?.strength ?? 0.8;
        sliders.style_weights = { [id]: str };
        sliders.style_strength = str;
      }
    } else {
      if (sliders.styles.includes(id)) {
        sliders.styles = sliders.styles.filter((x) => x !== id);
        delete sliders.style_weights[id];
      } else {
        sliders.styles = [...sliders.styles, id];
        const sp = stylePresets.find((s) => s.id === id);
        if (sp && sp.strength !== undefined && sp.strength !== null) {
          sliders.style_weights[id] = sp.strength;
        }
      }
      sliders.style = sliders.styles[0] || "none";
      if (sliders.styles.length > 0 && sliders.style_weights[sliders.style]) {
        sliders.style_strength = sliders.style_weights[sliders.style];
      }
    }
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  function updateStyleWeight(id, val) {
    if (!sliders.style_weights) sliders.style_weights = {};
    sliders.style_weights[id] = val;
    if (sliders.style === id) {
      sliders.style_strength = val;
    }
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  function toggleArchetype(id, multi = false) {
    if (!sliders.archetypes) sliders.archetypes = [];
    if (!sliders.archetype_weights) sliders.archetype_weights = {};

    if (!multi) {
      if (sliders.archetypes.length === 1 && sliders.archetypes[0] === id) {
        sliders.archetypes = [];
        sliders.archetype = null;
        sliders.archetype_weights = {};
      } else {
        sliders.archetypes = [id];
        sliders.archetype = id;
        const foundAp = archetypePresets.find((a) => a.id === id);
        const str = foundAp?.strength ?? 0.4;
        sliders.archetype_weights = { [id]: str };
        sliders.archetype_strength = str;
      }
    } else {
      if (sliders.archetypes.includes(id)) {
        sliders.archetypes = sliders.archetypes.filter((x) => x !== id);
        delete sliders.archetype_weights[id];
      } else {
        sliders.archetypes = [...sliders.archetypes, id];
        const foundAp = archetypePresets.find((a) => a.id === id);
        if (foundAp && foundAp.strength !== undefined && foundAp.strength !== null) {
          sliders.archetype_weights[id] = foundAp.strength;
        }
      }
      sliders.archetype = sliders.archetypes[0] || null;
      if (sliders.archetypes.length > 0 && sliders.archetype_weights[sliders.archetype]) {
        sliders.archetype_strength = sliders.archetype_weights[sliders.archetype];
      }
    }
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  function updateArchetypeWeight(id, val) {
    if (!sliders.archetype_weights) sliders.archetype_weights = {};
    sliders.archetype_weights[id] = val;
    if (sliders.archetype === id) {
      sliders.archetype_strength = val;
    }
    sliders = { ...sliders };
    saveLocalSliders(sliders);
  }

  function openCreatePersonaModal() {
    editingPersonaId = null;
    personaFormName = "";
    personaFormTitle = "";
    personaFormPrompt = "";
    personaFormAvatarData = "";
    personaFormAvatarPreview = "";
    showPersonaModal = true;
  }

  function openEditPersonaModal(p) {
    editingPersonaId = p.id;
    personaFormName = p.name || "";
    personaFormTitle = p.title || "";
    personaFormPrompt = p.prompt || "";
    personaFormAvatarData = p.avatarData || "";
    personaFormAvatarPreview = p.avatar || "";
    showPersonaModal = true;
  }

  function openAiPersonaModal() {
    aiFactoryArchetype = "alt";
    generatedAiPersona = null;
    showAiFactoryModal = true;
  }

  function downscaleImage(dataUrl, maxDim = 768) {
    return new Promise((resolve) => {
      if (typeof Image === "undefined") {
        resolve(dataUrl);
        return;
      }
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w <= maxDim && h <= maxDim) {
          resolve(dataUrl);
          return;
        }
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function handleAvatarUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const rawDataUrl = ev.target.result;
      const dataUrl = await downscaleImage(rawDataUrl, 768);
      personaFormAvatarData = dataUrl;
      personaFormAvatarPreview = dataUrl;
      if (!personaFormPrompt.trim()) {
        await analyzeFaceForPassport(dataUrl);
      }
    };
    reader.readAsDataURL(file);
  }

  async function analyzeFaceForPassport(imgInput) {
    const imgData = imgInput || personaFormAvatarData || personaFormAvatarPreview;
    if (!imgData) {
      alert($_("krea_err_upload_face_first", {}, "Сначала загрузите фотографию лица."));
      return;
    }
    isAnalyzingFace = true;
    try {
      const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
        ? (p, opts) => httpDrive.fetch(p, opts)
        : (p, opts) => fetch(p, opts);

      const res = await fetchFn("/personas/describe-face", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: imgData,
          omd_key: omdKey || ""
        })
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.prompt) {
        personaFormPrompt = data.prompt;
      }
      if (data.title && !personaFormTitle.trim()) {
        personaFormTitle = data.title;
      }
    } catch (err) {
      console.warn("[KreaStudio] Face vision error:", err);
      alert($_("krea_err_vision_failed", { error: err.message }, `Не удалось распознать черты лица через Vision: ${err.message}`));
    } finally {
      isAnalyzingFace = false;
    }
  }

  const archetypeDefaultPassports = {
    domi: "DomiK, attractive woman with piercing hazel gaze, shoulder-length stylish layered haircut, confident radiant smile, modern chic outfit, magnetic presence",
    ada: "ada_wong, short sleek black bob hair, elegant crimson silk dress, captivating dark eyes, confident enigmatic expression, cinematic espionage aesthetics",
    brie: "kxbrie woman, blonde wavy hair, sparkling blue eyes, radiant playful smile, sun-kissed natural complexion, stylish casual summer attire",
    tifa: "Stunning athletic martial artist with long waist-length glossy black hair tied in dolphin-tail tip, captivating ruby-red eyes, toned athletic build, iconic white top with suspenders",
    alt: "Young alternative woman with chin-length jet-black hair with vibrant purple streaks, dark winged eyeliner, small silver nose ring, velvet choker, expressive moody gaze",
    influencer: "Stunning 22-year-old lifestyle influencer with long wavy honey-blonde hair, warm hazel eyes, glowing tanned skin, soft natural makeup, charming candid smile",
    business: "Sophisticated modern woman with sleek dark brunette bob, confident warm brown eyes, sharp tailored blazer, intelligent poised expression",
    cyberpunk: "Futuristic young cyber-operative with asymmetrical platinum hair and teal neon tips, glowing optic cyberware around temple, dark techwear jacket",
    anime: "Artistic girl with voluminous pastel pink wavy hair, large luminous violet eyes, playful gentle expression, delicate porcelain skin",
    luna: "Lun4, attractive young woman, sweet and flirtatious gaze, charming smile, alluring presence"
  };

  async function generateAvatarForPersona() {
    if (isGeneratingAvatar) return;
    let cleanPrompt = personaFormPrompt.trim();
    if (!cleanPrompt && avatarGenArchetype && avatarGenArchetype !== "prompt") {
      const archPreset = (kreaPresets.archetypes || []).find(a => a.id === avatarGenArchetype);
      cleanPrompt = (archPreset && archPreset.trigger) || archetypeDefaultPassports[avatarGenArchetype] || "";
      if (cleanPrompt) {
        personaFormPrompt = cleanPrompt;
      }
    }

    if (!cleanPrompt && avatarGenArchetype === "prompt") {
      alert($_("krea_err_fill_passport", {}, "Заполните словесный паспорт персоны или выберите типаж для генерации аватара."));
      return;
    }

    isGeneratingAvatar = true;
    try {
      const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
        ? (p, opts) => httpDrive.fetch(p, opts)
        : (p, opts) => fetch(p, opts);

      let chosenSliders = { style: "photorealistic", detail: 0.5 };
      if (avatarGenArchetype && avatarGenArchetype !== "prompt") {
        chosenSliders.archetypes = [avatarGenArchetype];
      }

      const mcpPayload = getMcpPayload();
      const res = await fetchFn("/generate/krea2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "close-up headshot avatar portrait, looking directly at camera, soft studio rim light, natural skin detail, crisp sharp focus",
          persona_prompt: cleanPrompt || "",
          sliders: chosenSliders,
          width: 768,
          height: 768,
          steps: 6,
          cfg: 1.0,
          omd_key: omdKey || "",
          mcp_keys: mcpPayload,
          settings: { mcp_keys: mcpPayload }
        })
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.url) {
        const imgResp = await fetchFn(data.url);
        if (imgResp.ok) {
          const blob = await imgResp.blob();
          const base64 = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
          if (base64) {
            personaFormAvatarPreview = base64;
            personaFormAvatarData = base64;
          }
        }
      }
    } catch (err) {
      console.error("[KreaStudio] Avatar generation error:", err);
      alert($_("krea_err_avatar_gen", { error: err.message }, `Ошибка генерации аватара: ${err.message}`));
    } finally {
      isGeneratingAvatar = false;
    }
  }

  async function savePersona() {
    if (!personaFormName.trim() || !personaFormPrompt.trim()) return;
    isSavingPersona = true;
    try {
      const id = editingPersonaId || ("persona_" + Date.now());
      const pObj = {
        id,
        name: personaFormName.trim(),
        title: personaFormTitle.trim() || "Character",
        prompt: personaFormPrompt.trim(),
        avatar: personaFormAvatarPreview || "",
        avatarData: personaFormAvatarData || "",
        createdAt: Date.now()
      };

      // 1. Первичное и авторитетное хранилище — целевой накопитель пользователя (P2P Drive)
      const drive = getTargetDrive();
      if (drive && (drive.isConnected || drive.status === "connected")) {
        const pFolder = getPersonasFolder();
        await ensureFolderRecursive(drive, pFolder);
        try {
          await writeDriveText(drive, `${pFolder}/${id}.json`, JSON.stringify(pObj, null, 2));
          if (personaFormAvatarData) {
            const b64 = personaFormAvatarData.includes(",") ? personaFormAvatarData.split(",")[1] : personaFormAvatarData;
            await writeDriveFile(drive, `${pFolder}/${id}.png`, b64);
          }
        } catch (err) {
          console.warn("[KreaStudio] Failed saving persona to drive:", err);
        }
      }

      // 2. На AI-ноду сохраняем ТОЛЬКО если пользователь явно выбрал саму ноду как целевой накопитель
      const targetDev = resolveDevice();
      const isAiNodeTarget = Boolean(targetDev && targetDev.isAiNode);
      if (isAiNodeTarget) {
        try {
          const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
            ? (p, opts) => httpDrive.fetch(p, opts)
            : (p, opts) => fetch(p, opts);
          const postPayload = JSON.stringify({ ...pObj, omd_key: omdKey || "", save_local: true });
          const postHeaders = { "Content-Type": "application/json" };
          const res = await fetchFn("/personas", {
            method: "POST",
            headers: postHeaders,
            body: postPayload
          });
          if (res.ok) {
            const resData = await res.json();
            if (resData.persona) {
              if (resData.persona.avatar_url) pObj.avatar_url = resData.persona.avatar_url;
              if (!pObj.avatar && resData.persona.avatar) pObj.avatar = resData.persona.avatar;
            }
          }
        } catch (err) {
          console.warn("[KreaStudio] Error saving persona to AI node:", err);
        }
      }

      const existingIdx = personas.findIndex((x) => x.id === id);
      if (existingIdx !== -1) {
        personas[existingIdx] = pObj;
        personas = [...personas];
      } else {
        personas = [pObj, ...personas];
      }

      if (selectedPersonas.some((x) => x.id === id)) {
        selectedPersonas = selectedPersonas.map((x) => (x.id === id ? pObj : x));
      }

      showPersonaModal = false;
    } catch (err) {
      console.error("[KreaStudio] Error saving persona:", err);
    } finally {
      isSavingPersona = false;
    }
  }

  function deletePersona(p, e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    deleteConfirmTarget = {
      type: "persona",
      item: p,
      title: $_("delete_persona_title", {}, "Удалить персону"),
      name: p.name || $_("krea_persona", {}, "Персона"),
      subtext: $_("delete_persona_subtext", {}, "Словесный паспорт и аватар персоны будут безвозвратно удалены.")
    };
  }

  async function executeDeletePersona(p) {
    // 1. Удаляем из целевого накопителя (P2P Drive)
    const drive = getTargetDrive();
    if (drive && (drive.isConnected || drive.status === "connected")) {
      const pFolder = getPersonasFolder();
      try {
        if (typeof drive.unlink === "function") {
          await drive.unlink(`${pFolder}/${p.id}.json`).catch(() => {});
          await drive.unlink(`${pFolder}/${p.id}.png`).catch(() => {});
        } else if (typeof drive.removeFile === "function") {
          await drive.removeFile(`${pFolder}/${p.id}.json`).catch(() => {});
          await drive.removeFile(`${pFolder}/${p.id}.png`).catch(() => {});
        } else if (typeof drive.deleteFile === "function") {
          await drive.deleteFile(`${pFolder}/${p.id}.json`).catch(() => {});
          await drive.deleteFile(`${pFolder}/${p.id}.png`).catch(() => {});
        }
      } catch (_) {}
    }

    // 2. С AI-ноды удаляем ТОЛЬКО если она была выбрана как целевой накопитель
    const targetDev = resolveDevice();
    if (targetDev && targetDev.isAiNode) {
      try {
        const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
          ? (p, opts) => httpDrive.fetch(p, opts)
          : (p, opts) => fetch(p, opts);
        await fetchFn(`/personas/${p.id}`, { method: "DELETE" });
      } catch (err) {
        console.warn("[KreaStudio] Error deleting persona via API:", err);
      }
    }

    personas = personas.filter((x) => x.id !== p.id);
    selectedPersonas = selectedPersonas.filter((x) => x.id !== p.id);
  }

  async function generateAiPersona() {
    isGeneratingAiPersona = true;
    generatedAiPersona = null;
    try {
      const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
        ? (p, opts) => httpDrive.fetch(p, opts)
        : (p, opts) => fetch(p, opts);

      const mcpPayload = getMcpPayload();
      const res = await fetchFn("/personas/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          archetype: aiFactoryArchetype,
          omd_key: omdKey || "",
          mcp_keys: mcpPayload,
          settings: { mcp_keys: mcpPayload }
        })
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      generatedAiPersona = data;
    } catch (err) {
      console.error("[KreaStudio] AI Persona generation error:", err);
      alert($_("krea_err_persona_gen", { error: err.message }, `Ошибка генерации персоны: ${err.message}`));
    } finally {
      isGeneratingAiPersona = false;
    }
  }

  async function saveAiGeneratedPersona() {
    if (!generatedAiPersona) return;
    const pObj = {
      id: generatedAiPersona.id || ("persona_" + Date.now()),
      name: generatedAiPersona.name,
      title: generatedAiPersona.title,
      prompt: generatedAiPersona.prompt,
      avatar: generatedAiPersona.avatar || "",
      avatarData: generatedAiPersona.avatarData || generatedAiPersona.avatar || "",
      createdAt: Date.now()
    };

    // 1. Первичное сохранение — в целевой накопитель (P2P Drive)
    const drive = getTargetDrive();
    if (drive && (drive.isConnected || drive.status === "connected")) {
      const pFolder = getPersonasFolder();
      await ensureFolderRecursive(drive, pFolder);
      try {
        await writeDriveText(drive, `${pFolder}/${pObj.id}.json`, JSON.stringify(pObj, null, 2));
        if (pObj.avatarData) {
          const b64 = pObj.avatarData.includes(",") ? pObj.avatarData.split(",")[1] : pObj.avatarData;
          await writeDriveFile(drive, `${pFolder}/${pObj.id}.png`, b64);
        }
      } catch (err) {
        console.warn("[KreaStudio] Error saving generated AI persona to drive:", err);
      }
    }

    // 2. На AI-ноду сохраняем ТОЛЬКО если нода выбрана как целевой накопитель
    const targetDev = resolveDevice();
    const isAiNodeTarget = Boolean(targetDev && targetDev.isAiNode);
    if (isAiNodeTarget) {
      try {
        const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
          ? (p, opts) => httpDrive.fetch(p, opts)
          : (p, opts) => fetch(p, opts);
        const postPayload = JSON.stringify({ ...pObj, omd_key: omdKey || "", save_local: true });
        const postHeaders = { "Content-Type": "application/json" };
        const res = await fetchFn("/personas", {
          method: "POST",
          headers: postHeaders,
          body: postPayload
        });
        if (res.ok) {
          const resData = await res.json();
          if (resData.persona) {
            if (resData.persona.avatar_url) pObj.avatar_url = resData.persona.avatar_url;
            if (!pObj.avatar && resData.persona.avatar) pObj.avatar = resData.persona.avatar;
          }
        }
      } catch (err) {
        console.warn("[KreaStudio] Error saving generated persona to AI node:", err);
      }
    }

    personas = [pObj, ...personas];
    selectedPersonas = [pObj, ...selectedPersonas.filter((x) => x.id !== pObj.id)];
    showAiFactoryModal = false;
    generatedAiPersona = null;
  }

  async function loadPersonas() {
    let loaded = [];
    const drive = getTargetDrive();
    const pFolder = getPersonasFolder();

    // 1. Сначала загружаем персоны с диска через бэкенд API (/personas)
    try {
      const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
        ? (p, opts) => httpDrive.fetch(p, opts)
        : (p, opts) => fetch(p, opts);
      const res = await fetchFn("/personas");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.personas) && data.personas.length > 0) {
          loaded = data.personas;
        }
      }
    } catch (err) {
      console.warn("[KreaStudio] Error loading personas from API:", err);
    }

    // 2. Дополняем и синхронизируем из P2P Drive (/${base}/personas)
    if (drive && !drive.isConnected && typeof drive.waitUntilConnected === "function") {
      await drive.waitUntilConnected(2000).catch(() => {});
    }

    if (drive && (drive.isConnected || drive.status === "connected")) {
      await ensureFolderRecursive(drive, pFolder);
      try {
        let files = [];
        if (typeof drive.getFiles === "function") {
          files = await drive.getFiles(pFolder);
        } else if (typeof drive.list === "function") {
          files = await drive.list(pFolder);
        }
        if (Array.isArray(files)) {
          const jsonFiles = files.filter((f) => {
            const name = f.name || f.value || f;
            return typeof name === "string" && name.endsWith(".json") && !name.startsWith(".");
          });
          const drivePersonas = [];
          for (const jf of jsonFiles) {
            const fname = jf.name || jf.value || jf;
            try {
              const text = await readDriveText(drive, `${pFolder}/${fname}`);
              if (text) {
                const pData = JSON.parse(text);
                const baseName = fname.replace(/\.json$/, "");
                const avatarData = await readDriveBlobAsDataUrl(drive, `${pFolder}/${baseName}.png`);
                if (avatarData) {
                  pData.avatar = avatarData;
                  pData.avatarData = avatarData;
                }
                drivePersonas.push(pData);
              }
            } catch (_) {}
          }
          if (drivePersonas.length > 0) {
            const driveIds = new Set(drivePersonas.map((p) => p.id));
            loaded = [...drivePersonas, ...loaded.filter((p) => !driveIds.has(p.id))];
          }
        }
      } catch (_) {}
    }

    personas = loaded;
    // Подгружаем аватары через fetchFn и конвертируем в Data URL (base64) для автономной передачи
    const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
      ? (path, opts) => httpDrive.fetch(path, opts)
      : (path, opts) => fetch(path, opts);
    for (const p of personas) {
      if (p.avatar && (p.avatar.startsWith("/personas/") || p.avatar.startsWith("/assistant/avatar")) && !p.avatar.startsWith("data:")) {
        try {
          const avRes = await fetchFn(p.avatar);
          if (avRes.ok) {
            const blob = await avRes.blob();
            if (blob && blob.size > 0) {
              const reader = new FileReader();
              const b64 = await new Promise((res) => {
                reader.onload = () => res(reader.result);
                reader.onerror = () => res(null);
                reader.readAsDataURL(blob);
              });
              if (b64) {
                p.avatar = b64;
                p.avatarData = b64;
              }
            }
          }
        } catch (_) {}
      }
    }
    personas = [...personas];
    selectedPersonas = getLocalSelectedPersonas(personas);
  }

  async function loadCreations() {
    isLoadingFiles = true;
    const targetFolder = getTargetFolder();
    let rawList = [];
    let effectiveFolder = targetFolder;

    const resDev = resolveDevice();
    let activeDrive = resDev?.drive || deviceDrive;

    if (activeDrive && !activeDrive.isConnected && typeof activeDrive.waitUntilConnected === "function") {
      await activeDrive.waitUntilConnected(2000).catch(() => {});
    }

    const rawStorage = (defaultStorage || "").trim();
    const parsedStorage = parseStoragePath(rawStorage);
    const hasSpecificDevice = !!(parsedStorage.deviceName && parsedStorage.deviceName.toLowerCase() !== "local");

    // When a specific target device is configured (e.g. /Linux-desktop/Private/OnMyChat),
    // strictly scan ONLY that target folder on that device!
    const candidateFolders = [targetFolder];
    if (!hasSpecificDevice) {
      const cleanBase = getBaseStorage();
      if (cleanBase && !candidateFolders.includes(`/${cleanBase}/generated`)) {
        candidateFolders.push(`/${cleanBase}/generated`);
      }
      if (!candidateFolders.includes("/Private/OnMyChat/generated")) {
        candidateFolders.push("/Private/OnMyChat/generated");
      }
      if (!candidateFolders.includes("/OnMyChat/generated")) {
        candidateFolders.push("/OnMyChat/generated");
      }
      if (!candidateFolders.includes("/Data/generated")) {
        candidateFolders.push("/Data/generated");
      }
      if (!candidateFolders.includes("/generated")) {
        candidateFolders.push("/generated");
      }
    }

    try {
      if (activeDrive && typeof activeDrive.getFiles === "function" && (activeDrive.isConnected || activeDrive.status === "connected")) {
        for (const cand of candidateFolders) {
          try {
            const devFiles = await activeDrive.getFiles(cand);
            if (Array.isArray(devFiles) && devFiles.length > 0) {
              rawList = devFiles;
              effectiveFolder = cand;
              break;
            }
          } catch (e) {}
        }
      }

      // ONLY if NO specific device was chosen and no files were found, check other local devices or httpDrive
      if (!hasSpecificDevice && (!rawList || rawList.length === 0)) {
        const otherConnected = deviceRegistry.list().filter(
          (d) => d && !d.isAiNode && d.drive && (d.drive.isConnected || d.drive.status === "connected") && d.drive !== activeDrive
        );
        for (const dev of otherConnected) {
          for (const cand of candidateFolders) {
            try {
              const devFiles = await dev.drive.getFiles(cand);
              if (Array.isArray(devFiles) && devFiles.length > 0) {
                rawList = devFiles;
                effectiveFolder = cand;
                activeDrive = dev.drive;
                break;
              }
            } catch (_) {}
          }
          if (rawList && rawList.length > 0) break;
        }
      }

      if (!hasSpecificDevice && (!rawList || rawList.length === 0) && httpDrive && typeof httpDrive.fetch === "function") {
        for (const cand of candidateFolders.slice(0, 2)) {
          try {
            const res = await httpDrive.fetch(`/api/v1/files?path=${encodeURIComponent(cand)}`);
            if (res && res.ok) {
              const data = await res.json();
              const list = data.list || data.files || [];
              if (Array.isArray(list) && list.length > 0) {
                rawList = list;
                effectiveFolder = cand;
                break;
              }
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      console.error("[KreaStudio] Error scanning folder:", err);
    }

    const imageExtRegex = /\.(jpe?g|png|webp|gif)$/i;
    const imageFiles = (rawList || []).filter((f) => {
      const name = f.name || f.value || "";
      if (!name) return false;
      if (name.startsWith(".") || name === "folder.jpg" || name.endsWith(".cover.jpg") || name.endsWith(".cover.png")) return false;
      return imageExtRegex.test(name) && !f.isDir;
    });

    let localPromptCache = {};
    try {
      localPromptCache = JSON.parse(localStorage.getItem("krea_file_prompts") || "{}");
    } catch (_) {}

    const parsedItems = imageFiles.map((f) => {
      const name = f.name || f.value;
      const cleanPath = `${effectiveFolder}/${name}`.replace(/\/+/g, "/");
      let mtime = getItemTimestamp({ name, date: f.lastModified || f.date || (f.mtime ? f.mtime * 1000 : null) }) || Date.now();
      return {
        id: name,
        name,
        path: cleanPath,
        title: name.replace(/\.[^.]+$/, ""),
        description: "",
        prompt: localPromptCache[name] || "",
        blobUrl: imageBlobCache[cleanPath] || imageBlobCache[name] || null,
        persona: "",
        date: mtime
      };
    });

    items = sortItemsList(parsedItems, sortOrder);
    isLoadingFiles = false;
    dispatch("count-change", items.length);

    await tick();
    initLightGallery();

    // Быстрая асинхронная проверка через GunDB (chatStore) для недостающих промптов
    if (chatStore && typeof chatStore.getPromptForFile === "function") {
      for (const item of items) {
        if (!item.prompt) {
          chatStore.getPromptForFile(item.name).then((p) => {
            if (p) {
              item.prompt = p;
              items = [...items];
              try {
                const cache = JSON.parse(localStorage.getItem("krea_file_prompts") || "{}");
                cache[item.name] = p;
                localStorage.setItem("krea_file_prompts", JSON.stringify(cache));
              } catch (_) {}
            }
          }).catch(() => {});
        }
      }
    }

    fetchMissingPrompts(effectiveFolder, activeDrive);
  }

  async function fetchMissingPrompts(effectiveFolder, activeDrive) {
    const drive = activeDrive || getTargetDrive();
    for (const item of items) {
      if (item.prompt && item.description && item.title !== item.name.replace(/\.[^.]+$/, "")) continue;
      const readmePath = item.path.replace(/\.[^/.]+$/, "") + ".Readme.md";
      const baseName = item.name.replace(/\.[^/.]+$/, "") + ".Readme.md";
      try {
        let txt = "";
        // 1. Читаем из целевого P2P Drive через readDriveText
        if (drive && (drive.isConnected || drive.status === "connected")) {
          txt = await readDriveText(drive, readmePath).catch(() => null);
        }
        // 2. Если на P2P drive нет, запрашиваем через httpDrive (с ноды)
        if (!txt && httpDrive && typeof httpDrive.fetch === "function") {
          const resp = await httpDrive.fetch(readmePath).catch(() => null);
          if (resp && resp.ok) {
            txt = await resp.text().catch(() => "");
          }
        }
        // 3. Fallback: прямой запрос к /generated/{baseName}
        if (!txt && typeof window !== "undefined") {
          const resp = await window.fetch(`/generated/${baseName}`).catch(() => null);
          if (resp && resp.ok) {
            txt = await resp.text().catch(() => "");
          }
        }
        if (txt) {
          const titleMatch = txt.match(/^#\s*([^\n]+)/);
          if (titleMatch) {
            item.title = titleMatch[1].trim();
          }
          const promptMatch = txt.match(/<!--\s*prompt:\s*([\s\S]*?)-->/i);
          if (promptMatch) {
            item.prompt = promptMatch[1].trim();
          }
          const descText = txt.replace(/<!--\s*prompt:[\s\S]*?-->/gi, "").replace(/^#\s*[^\n]+\n+/, "").trim();
          item.description = descText;
          if (!item.prompt) {
            item.prompt = descText;
          }
          if (item.prompt) {
            try {
              const cache = JSON.parse(localStorage.getItem("krea_file_prompts") || "{}");
              cache[item.name] = item.prompt;
              localStorage.setItem("krea_file_prompts", JSON.stringify(cache));
            } catch (_) {}
            if (chatStore && typeof chatStore.associateFileWithPrompt === "function") {
              chatStore.associateFileWithPrompt("", item.name, item.prompt).catch(() => {});
            }
          }
          items = [...items];
        }
      } catch (_) {}
    }
  }

  function deleteCreation(item, e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    deleteConfirmTarget = {
      type: "image",
      item: item,
      title: $_("delete_creation", {}, "Удалить изображение"),
      name: item.title || item.name || $_("krea_image", {}, "Изображение"),
      subtext: $_("delete_creation_subtext", {}, "Файл будет безвозвратно удалён из подключенного хранилища.")
    };
  }

  async function executeDeleteCreation(item) {
    try {
      const fullPath = item.path;
      const readmePath = fullPath.replace(/\.[^/.]+$/, "") + ".Readme.md";
      const drive = getTargetDrive();
      if (drive && typeof drive.removeFile === "function") {
        await drive.removeFile(fullPath, true).catch(() => {});
        await drive.removeFile(readmePath, true).catch(() => {});
      } else if (httpDrive && typeof httpDrive.fetch === "function") {
        await httpDrive.fetch(fullPath, { method: "DELETE" }).catch(() => {});
        await httpDrive.fetch(readmePath, { method: "DELETE" }).catch(() => {});
      }
      items = items.filter((x) => x.id !== item.id);
      dispatch("count-change", items.length);
      const key = item.path || item.name;
      if (imageBlobCache[key]) {
        try { URL.revokeObjectURL(imageBlobCache[key]); } catch (_) {}
        delete imageBlobCache[key];
      }
    } catch (err) {
      console.warn("[KreaStudio] Failed to delete creation:", err);
    }
  }

  async function executeConfirmDelete() {
    if (!deleteConfirmTarget || isDeletingItem) return;
    const target = deleteConfirmTarget;
    deleteConfirmTarget = null;
    isDeletingItem = true;
    try {
      if (target.type === "persona") {
        await executeDeletePersona(target.item);
      } else if (target.type === "image") {
        await executeDeleteCreation(target.item);
      }
    } catch (err) {
      console.error("[KreaStudio] Deletion error:", err);
    } finally {
      isDeletingItem = false;
    }
  }

  function getDevSegment() {
    const dev = resolveDevice();
    let seg = (dev?.prefix || dev?.linkId || targetLinkId || targetDevice?.linkId || dev?.name || targetDevice?.name || "").trim();
    seg = seg.replace(/^\/+|\/+$/g, "");
    return seg || "local";
  }

  function getThumbnailUrl(item) {
    if (!item) return "";
    if (item.blobUrl) return item.blobUrl;
    if (imageBlobCache[item.path]) return imageBlobCache[item.path];
    if (imageBlobCache[item.name]) return imageBlobCache[item.name];
    const dev = getDevSegment();
    const cleanPath = (item.path || "").startsWith("/") ? item.path : `/${item.path || ""}`;
    return `/p2p/${dev}${encodeURI(cleanPath)}?resize=true&width=480&height=480`;
  }

  function lazyLoad(node, src) {
    let currentSrc = src || "";
    let observer = null;
    const show = () => {
      if (currentSrc && node.getAttribute("src") !== currentSrc) {
        node.src = currentSrc;
      }
    };
    const root = null; // viewport-based lazy loading
    if (typeof IntersectionObserver === "undefined") {
      show();
      return {
        update(newSrc) { currentSrc = newSrc || ""; if (node.getAttribute("src")) node.src = currentSrc; },
        destroy() {}
      };
    }
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          show();
          try { observer.unobserve(node); } catch (_) {}
        }
      }
    }, { root, rootMargin: "400px 0px", threshold: 0.01 });
    observer.observe(node);
    return {
      update(newSrc) {
        currentSrc = newSrc || "";
        if (node.getAttribute("src") && currentSrc) {
          node.src = currentSrc;
        }
      },
      destroy() {
        try { observer && observer.disconnect(); } catch (_) {}
      }
    };
  }

  function getFullImageUrl(item) {
    if (!item) return "";
    if (item.blobUrl) return item.blobUrl;
    if (imageBlobCache[item.path]) return imageBlobCache[item.path];
    if (imageBlobCache[item.name]) return imageBlobCache[item.name];
    const dev = getDevSegment();
    const cleanPath = (item.path || "").startsWith("/") ? item.path : `/${item.path || ""}`;
    return `/p2p/${dev}${encodeURI(cleanPath)}`;
  }

  async function fetchImageBlobViaWebRTC(filePath, query = "") {
    const drive = getTargetDrive();
    if (!drive || !drive.isConnected) return null;
    try {
      if (typeof drive.sendRPC === "function" && typeof drive.getFileContent === "function") {
        const openRes = await drive.sendRPC("Open", { path: filePath, query });
        if (openRes && openRes.status === "ok" && openRes.result) {
          const totalSize = openRes.result.size || 0;
          const mimeType = openRes.result.mimeType || (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg") ? "image/jpeg" : "image/png");
          const rawBlob = await drive.getFileContent(filePath, totalSize, null, 0, query);
          if (rawBlob && rawBlob.size > 0) {
            const typedBlob = new Blob([rawBlob], { type: mimeType });
            return URL.createObjectURL(typedBlob);
          }
        }
      }
    } catch (e) {
      console.warn("[KreaStudio] WebRTC fetch blob failed:", filePath, e);
    }
    return null;
  }

  async function fetchLargeImageBlob(fetchFn, url) {
    const CHUNK_SIZE = 128 * 1024; // 128 KB safe chunk size for WebRTC SCTP
    let offset = 0;
    let totalLength = null;
    const chunks = [];

    while (totalLength === null || offset < totalLength) {
      const end = totalLength !== null ? Math.min(offset + CHUNK_SIZE - 1, totalLength - 1) : offset + CHUNK_SIZE - 1;
      const resp = await fetchFn(url, {
        headers: {
          Range: `bytes=${offset}-${end}`
        }
      });
      if (!resp.ok && resp.status !== 206) {
        if (offset === 0) {
          return await resp.blob();
        }
        throw new Error(`Range fetch failed: HTTP ${resp.status}`);
      }

      const cr = resp.headers.get("Content-Range") || resp.headers.get("content-range");
      if (cr) {
        const match = /\/(\d+)$/.exec(cr);
        if (match) totalLength = parseInt(match[1], 10);
      }
      const blob = await resp.blob();
      chunks.push(blob);
      offset += blob.size;
      if (blob.size === 0 || (totalLength !== null && offset >= totalLength)) {
        break;
      }
    }

    return new Blob(chunks, { type: "image/png" });
  }

  async function handleImageError(item, e) {
    if (!item || item._fallbackTried) return;
    if (!e || !e.target || !e.target.src || e.target.src === window.location.href) return;
    item._fallbackTried = true;

    // 1. Try reading via WebRTC getFileContent
    const webrtcBlobUrl = (await fetchImageBlobViaWebRTC(item.path, "resize=true&width=480&height=480")) ||
                          (await fetchImageBlobViaWebRTC(item.path, ""));
    if (webrtcBlobUrl) {
      item.blobUrl = webrtcBlobUrl;
      imageBlobCache[item.path] = webrtcBlobUrl;
      imageBlobCache[item.name] = webrtcBlobUrl;
      if (e && e.target) e.target.src = webrtcBlobUrl;
      return;
    }

    // 2. Try reading via drive homeRead
    const drive = getTargetDrive();
    if (drive) {
      try {
        if (typeof drive.homeRead === "function") {
          const b64 = await drive.homeRead(item.path);
          if (b64) {
            item.blobUrl = `data:image/png;base64,${b64}`;
            imageBlobCache[item.path] = item.blobUrl;
            imageBlobCache[item.name] = item.blobUrl;
            if (e && e.target) e.target.src = item.blobUrl;
            return;
          }
        }
      } catch (_) {}
    }

    // 3. Try fetching from ephemeral /chat/image/{filename} via safe chunks
    try {
      const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
        ? (p, opts) => httpDrive.fetch(p, opts)
        : (p, opts) => fetch(p, opts);
      const blob = await fetchLargeImageBlob(fetchFn, `/chat/image/${item.name}`);
      if (blob && blob.size > 0) {
        item.blobUrl = URL.createObjectURL(blob);
        imageBlobCache[item.path] = item.blobUrl;
        imageBlobCache[item.name] = item.blobUrl;
        if (e && e.target) e.target.src = item.blobUrl;
        return;
      }
    } catch (_) {}
  }

  function buildDevicePush() {
    try {
      const storage = (defaultStorage || "").trim();
      const parsed = parseStoragePath(storage);
      let targetDev = parsed.device || resolveDevice() || targetDevice || null;
      if ((!targetDev || targetDev.local) && parsed.deviceName && parsed.deviceName.toLowerCase() !== "local") {
        const found = deviceRegistry.getByName(parsed.deviceName) ||
                      deviceRegistry.getByPrefix(parsed.deviceName) ||
                      deviceRegistry.get(parsed.deviceName);
        if (found) targetDev = found;
      }

      const aiNodeId = targetLinkId || (targetDevice && targetDevice.isAiNode ? targetDevice.linkId : "") || httpDrive?.targetLinkId || "";
      const server = getClientDeviceServer();
      let linkId = targetDev?.linkId || server?.linkId || getOrCreateLocalLinkId();
      if (linkId === parsed.deviceName || linkId === "local" || linkId === "This Device") {
        linkId = server?.linkId || getOrCreateLocalLinkId();
      }
      if (!linkId || (aiNodeId && linkId.toLowerCase() === aiNodeId.toLowerCase())) {
        return null;
      }
      const folder = getTargetFolder().replace(/^\/+/, "");
      if (!folder) return null;
      const grant = issueConsent(folder, { writable: true, openWindow: false });
      if (!grant?.token) return null;
      const didPub = (typeof window !== "undefined" && (window.identity?.mainPub || window.identity?.pair?.pub)) || "";
      return { linkId, consentToken: grant.token, folder, didPub };
    } catch (e) {
      console.warn("[KreaStudio] buildDevicePush error:", e);
      return null;
    }
  }

  async function runGeneration() {
    const cleanPrompt = promptText.trim();
    if (!cleanPrompt && selectedPersonas.length === 0) return;
    if (isGenerating) return;

    // Save prompt to history
    if (cleanPrompt) {
      if (chatStore && typeof chatStore.savePrompt === "function") {
        chatStore.savePrompt(cleanPrompt, sliders.style || "krea").catch(() => {});
      }
      const newEntry = {
        id: "p_" + Date.now(),
        text: cleanPrompt,
        style: sliders.style || "krea",
        lastUsed: new Date().toISOString()
      };
      recentPrompts = [newEntry, ...recentPrompts.filter((x) => (x.text || x.prompt || x) !== cleanPrompt)].slice(0, 50);
      try {
        localStorage.setItem("krea_recent_prompts", JSON.stringify(recentPrompts));
      } catch (_) {}
    }

    isGenerating = true;
    generatingPrompt = cleanPrompt || selectedPersonas.map((p) => p.name).join(", ");
    generatingPersona = selectedPersonas.map((p) => p.name).join(", ");
    
    // Check if GPU is warm:
    const now = Date.now();
    const isRecentlyUsed = lastGenFinishedAt > 0 && (now - lastGenFinishedAt < 290000);
    const warm = isGpuWarm || isRecentlyUsed;
    generatingStage = warm ? "generating" : "warming";

    activeTab = "gallery";
    generationElapsed = 0;
    const t0 = Date.now();
    generationTimer = setInterval(() => {
      generationElapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (generatingStage === "warming" && Number(generationElapsed) >= 20) {
        generatingStage = "generating";
      }
    }, 100);

    const [wStr, hStr] = sliders.aspect.split("x");
    const width = parseInt(wStr, 10) || 896;
    const height = parseInt(hStr, 10) || 1152;

    // Собираем референсные изображения (только вручную прикрепленные пользователем)
    const resolvedRefImages = [];
    if (attachedReferences.length > 0) {
      for (const r of attachedReferences) {
        const d = r.dataUrl || r.preview;
        if (d && typeof d === "string") resolvedRefImages.push(d);
      }
    }

    const targetDev = resolveDevice();
    const isAiNodeTarget = Boolean(targetDev && targetDev.isAiNode);
    const baseStorage = getBaseStorage();

    const payload = {
      omd_key: omdKey || (typeof window !== "undefined" && window.__omdKey) || "",
      prompt: promptText.trim(),
      persona_id: selectedPersonas.length > 0 ? selectedPersonas.map((p) => p.id).join(",") : null,
      persona_name: selectedPersonas.length > 0 ? selectedPersonas.map((p) => p.name).join(", ") : null,
      persona_prompt: selectedPersonas.length > 0 ? selectedPersonas.map((p) => p.prompt || p.passport || "").join("; ") : "",
      reference_images: resolvedRefImages,
      reference_image: resolvedRefImages[0] || null,
      sliders: {
        base_model: sliders.base_model || "realism",
        detail: sliders.detail,
        styles: Array.isArray(sliders.styles) ? sliders.styles.filter((x) => x && x !== "none") : [],
        style: (sliders.styles && sliders.styles.length > 0) ? sliders.styles[0] : "none",
        style_weights: sliders.style_weights || {},
        style_strength: sliders.style_strength,
        archetypes: Array.isArray(sliders.archetypes) ? sliders.archetypes.filter(Boolean) : [],
        archetype: (sliders.archetypes && sliders.archetypes.length > 0) ? sliders.archetypes[0] : null,
        archetype_weights: sliders.archetype_weights || {},
        archetype_strength: sliders.archetype_strength
      },
      width,
      height,
      steps: sliders.steps || (sliders.base_model === "realism" ? 14 : (sliders.base_model === "semi_realism" ? 16 : 25)),
      cfg: sliders.cfg || (sliders.base_model === "realism" ? 1.5 : (sliders.base_model === "semi_realism" ? 2.0 : 3.0)),
      client: "svar",
      image_delivery: "inline",
      save_local: true,
      mcp_keys: getMcpPayload(),
      settings: {
        defaultStorage: baseStorage,
        client: "svar",
        image_delivery: "inline",
        mcp_keys: getMcpPayload()
      }
    };

    const abortCtrl = new AbortController();
    const timeoutHandle = setTimeout(() => {
      try { abortCtrl.abort(); } catch (_) {}
    }, 180000);

    try {
      let res = null;
      const requestHeaders = {
        "Content-Type": "application/json",
        "X-Client": "svar"
      };
      const activeToken = omdKey || (typeof window !== "undefined" && (window.__omdKey || window.identity?.token)) || "";
      if (activeToken) {
        requestHeaders["Token"] = activeToken;
        requestHeaders["X-OMD-Token"] = activeToken;
      }
      const effectiveDid = (httpDrive && httpDrive.didPub) || (typeof window !== "undefined" && (window.identity?.mainPub || window.identity?.pair?.pub)) || "";
      if (effectiveDid) {
        requestHeaders["X-OMD-Caller-DID"] = effectiveDid;
      }
      if (httpDrive && httpDrive.isPrivateMode !== undefined) {
        requestHeaders["X-OMD-Private-Mode"] = httpDrive.isPrivateMode ? "1" : "0";
      } else {
        requestHeaders["X-OMD-Private-Mode"] = "1";
      }

      // 1. Через P2P-туннель к ноде (httpDrive)
      if (httpDrive && typeof httpDrive.fetch === "function") {
        try {
          res = await httpDrive.fetch("/generate/krea2", {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(payload),
            signal: abortCtrl.signal,
            timeoutMs: 180000
          });
        } catch (driveErr) {
          throw new Error(`Ошибка P2P-связи с нодой: ${driveErr.message || driveErr}. Пожалуйста, обновите страницу (F5).`);
        }
      } else {
        // 2. Прямой HTTP-запрос (только если приложение запущено без P2P-драйва)
        res = await fetch("/generate/krea2", {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(payload),
          signal: abortCtrl.signal
        });
      }

      if (!res || !res.ok) {
        let errDetail = res ? `HTTP ${res.status}` : "Нет ответа от сервера";
        if (res) {
          try {
            const errData = await res.json();
            if (errData && errData.detail) errDetail = errData.detail;
            else if (errData && errData.error) errDetail = errData.error;
          } catch (_) {}
        }
        throw new Error(errDetail);
      }

      const data = await res.json();
      const filename = data.image || `krea_${Date.now()}.png`;

      // GPU generation completed — now downloading chunk stream and saving!
      generatingStage = "saving";
      isGpuWarm = true;
      lastGenFinishedAt = Date.now();

      const folder = getTargetFolder();
      const fullImagePath = `${folder}/${filename}`;

      let localBlobUrl = null;
      let imageBlob = null;
      if (data.url) {
        try {
          imageBlob = await fetchLargeImageBlob(fetchFn, data.url);
          if (imageBlob && imageBlob.size > 0) {
            localBlobUrl = URL.createObjectURL(imageBlob);
            imageBlobCache[fullImagePath] = localBlobUrl;
            imageBlobCache[filename] = localBlobUrl;
            imageBlobCache = { ...imageBlobCache };
          }
        } catch (fetchErr) {
          console.warn("[KreaStudio] Preload/save error:", fetchErr);
        }
      }

      if (chatStore && typeof chatStore.associateFileWithPrompt === "function") {
        chatStore.associateFileWithPrompt("", filename, cleanPrompt).catch(() => {});
      }
      try {
        const cache = JSON.parse(localStorage.getItem("krea_file_prompts") || "{}");
        cache[filename] = cleanPrompt;
        localStorage.setItem("krea_file_prompts", JSON.stringify(cache));
      } catch (_) {}

      const newItem = {
        id: filename,
        name: filename,
        path: fullImagePath,
        title: data.title || promptText.slice(0, 30),
        description: data.description || "",
        prompt: cleanPrompt,
        blobUrl: localBlobUrl,
        persona: selectedPersonas.map((p) => p.name).join(", ") || "",
        date: Date.now(),
        gpuTime: data.gpu_time || null,
        totalTime: data.total_time || null
      };

      items = sortItemsList([newItem, ...items.filter((x) => x.id !== newItem.id)], sortOrder);
      dispatch("count-change", items.length);

      isGenerating = false;
      clearInterval(generationTimer);
      clearTimeout(timeoutHandle);

      activeTab = "gallery";
      await tick();
      initLightGallery();

      // Случай 2 и 3: Сохранение на целевое веб/remote устройство через фронтенд (targetDrive)
      if (!data.saved_locally && imageBlob) {
        const targetDrive = getTargetDrive();
        if (targetDrive) {
          if (!targetDrive.isConnected && typeof targetDrive.connect === "function") {
            try {
              await targetDrive.connect();
            } catch (connErr) {
              console.warn("[KreaStudio] Connect targetDrive error:", connErr);
            }
          }
          const reader = new FileReader();
          const base64Promise = new Promise((resolve) => {
            reader.onloadend = () => {
              const b64 = (reader.result || "").split(",")[1] || "";
              resolve(b64);
            };
            reader.onerror = () => resolve(null);
          });
          reader.readAsDataURL(imageBlob);
          const imageBase64 = await base64Promise;

          if (imageBase64) {
            try {
              await ensureFolderRecursive(targetDrive, folder);
              const title = data.title || promptText.slice(0, 30) || "";
              const desc = data.description || "";
              let readmeContent = `# ${title}\n\n${desc}\n`;
              if (cleanPrompt) {
                readmeContent += `\n<!-- prompt: ${cleanPrompt} -->\n`;
              }
              const readmeFilename = filename.replace(/\.[^/.]+$/, "") + ".Readme.md";
              const fullReadmePath = `${folder}/${readmeFilename}`;

              await writeDriveFile(targetDrive, fullImagePath, imageBase64);
              await writeDriveText(targetDrive, fullReadmePath, readmeContent);
              console.log("[KreaStudio] Successfully saved creation and companion Readme to drive:", fullImagePath);
            } catch (driveErr) {
              console.warn("[KreaStudio] Direct save to targetDrive warning:", driveErr);
            }
          }
        }
      }
    } catch (err) {
      console.error("[KreaStudio] Generation error:", err);
      if (err.name === "AbortError") {
        alert($_("krea_err_timeout", {}, "Таймаут генерации (3 мин): сетевой туннель или нода не ответили вовремя."));
      } else {
        alert($_("krea_err_generation", { error: err.message }, `Ошибка генерации: ${err.message}`));
      }
    } finally {
      clearTimeout(timeoutHandle);
      clearInterval(generationTimer);
      isGenerating = false;
    }
  }

  async function pickRandomSuggestion() {
    if (isRandomizingPrompt) return;
    isRandomizingPrompt = true;

    const fallbackGenerate = () => {
      const personaName = selectedPersonas.length > 0 ? selectedPersonas.map((p) => p.name).join(", ") : "";
      const hasChar = Boolean(personaName || (activeArchetypeObjs && activeArchetypeObjs.length > 0));
      const stylePart = (sliders.styles && sliders.styles.length > 0)
        ? `, ${sliders.styles.join(", ")} style`
        : ((sliders.style && sliders.style !== "none") ? `, ${sliders.style} style` : "");
      const lightings = [
        "bathed in warm golden hour rim lighting with long dramatic shadows",
        "illuminated by cool moody neon hues reflecting off slick wet surfaces",
        "soft diffuse morning skylight highlighting natural textures",
        "dramatic chiaroscuro lighting with deep rich blacks and vibrant warm highlights",
        "dappled sunlight filtering through lush tree canopy with subtle lens flare",
        "dim atmospheric twilight lighting creating an intimate serene warmth"
      ];
      const framings = [
        "sweeping panoramic establishing shot, monumental scale, crystal clear horizon",
        "dramatic low-angle ground perspective looking across sculpted geology toward the sky",
        "high-angle crane shot looking down across deep environmental layers",
        "cinematic wide-angle view, deep atmospheric backdrop, immersive depth"
      ];

      if (!hasChar) {
        const landscapes = [
          "Towering jagged alpine mountain peaks rising above a mirror-like turquoise glacial lake, morning mist weaving through pine forests",
          "A dramatic wind-swept coastal cliff overlooking churning ocean waves crashing against dark volcanic sea stacks",
          "Vast rolling desert sand dunes rippled by the wind, casting deep golden shadows under a twilight sky with a crescent moon",
          "An ancient mystical moss-covered redwood forest, ethereal god rays piercing through dense canopy illuminating winding streams",
          "Panoramic view of a sprawling neon-lit metropolis in twilight rain, towering glass spires reflecting amber sunset glow",
          "Majestic northern lights dancing in vibrant green and violet ribbons over a tranquil snow-covered Arctic fjord",
          "A deep sandstone slot canyon with sculpted undulating orange rock walls, warm ambient light glowing from above",
          "A tranquil secluded tropical cove with turquoise water gently lapping against powdery white sand, framed by wild lush cliffs"
        ];
        const ls = landscapes[Math.floor(Math.random() * landscapes.length)];
        const l = lightings[Math.floor(Math.random() * lightings.length)];
        const f = framings[Math.floor(Math.random() * framings.length)];
        return `${ls}, ${l}, ${f}${stylePart}.`;
      }

      const lead = personaName ? `${personaName}, ` : "";
      const actions = [
        "running swiftly across rain-slicked neon cobblestones, trench coat billowing in the wind",
        "stepping purposefully down a monumental concrete spiral staircase in a brutalist art gallery",
        "kneeling on one knee to inspect intricate antique clockwork gears on a subterranean vault floor",
        "leaning against the fender of a vintage roadster parked on an open coastal cliff overlooking crashing waves",
        "walking full-stride through an overgrown sunlit botanical atrium surrounded by towering palms and ferns",
        "working intently at a cluttered wooden workbench, soldering glowing vacuum tubes in a dimly lit workshop",
        "leaping gracefully across an industrial rooftop gap against a panoramic twilight skyline",
        "sitting cross-legged on a patterned kilim rug on an open desert terrace examining ancient star charts",
        "perched casually on the stone balustrade of a bridge spanning a misty river in early morning light",
        "hiking with dynamic energy along a wind-swept rocky mountain ridge as low clouds drift through the peaks",
        "striding purposefully through a crowded neon-lit market alley under heavy rain with a transparent umbrella",
        "skating fluidly down an oceanfront boulevard between swaying palm trees in warm afternoon light"
      ];
      const a = actions[Math.floor(Math.random() * actions.length)];
      const l = lightings[Math.floor(Math.random() * lightings.length)];
      const f = framings[Math.floor(Math.random() * framings.length)];
      return `${lead}${a}, ${l}, ${f}${stylePart}.`;
    };

    try {
      // Only pass promptText as keywords if it is a short user-typed topic (<= 4 words, no sentence punctuation)
      // Never pass an already generated full prompt as keywords!
      let userKeywords = "";
      const trimmed = (promptText || "").trim();
      const words = trimmed.split(/\s+/).filter(Boolean);
      if (words.length > 0 && words.length <= 4 && !/[.!?\n]/.test(trimmed)) {
        userKeywords = trimmed;
      }

      const archetypesStr = (activeArchetypeObjs || []).map(a => `${a.label} (${a.desc})`).join("; ");
      const stylesStr = (activeStyleObjs || []).map(s => s.name).join(", ");
      const payload = {
        omd_key: omdKey || "",
        persona_name: selectedPersonas.length > 0 ? selectedPersonas.map((p) => p.name).join(", ") : "",
        persona_prompt: selectedPersonas.length > 0 ? selectedPersonas.map((p) => p.prompt || p.passport || "").join("; ") : "",
        style: stylesStr || ((sliders.style && sliders.style !== "none") ? sliders.style : ""),
        archetypes: archetypesStr,
        keywords: userKeywords
      };

      let resp = null;

      // 1. Try P2P WebRTC data channel directly to OnMyChat API (binds this to httpDrive)
      if (httpDrive && typeof httpDrive.fetch === "function") {
        try {
          resp = await httpDrive.fetch("/generate/prompt/random", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
        } catch (driveErr) {
          console.warn("[KreaStudio] httpDrive.fetch failed:", driveErr);
        }
      }

      // 2. If httpDrive was not available or failed, try standard HTTP endpoints
      if (!resp || !resp.ok) {
        for (const ep of ["/generate/prompt/random", "/ai/generate/prompt/random"]) {
          try {
            const r = await fetch(ep, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            if (r.ok) {
              resp = r;
              break;
            }
          } catch (_) {}
        }
      }

      if (resp && resp.ok) {
        const data = await resp.json().catch(() => null);
        if (data && data.prompt && data.prompt.trim()) {
          promptText = data.prompt.trim();
        } else {
          promptText = fallbackGenerate();
        }
      } else {
        promptText = fallbackGenerate();
      }
    } catch (err) {
      console.warn("[KreaStudio] pickRandomSuggestion error:", err);
      promptText = fallbackGenerate();
    } finally {
      isRandomizingPrompt = false;
      await tick();
      resizeTextarea();
      if (textareaEl) textareaEl.focus();
    }
  }

  function selectPrompt(p) {
    promptText = typeof p === "string" ? p : p.text || p.prompt || "";
    showPromptsPopup = false;
    tick().then(() => {
      resizeTextarea();
      if (textareaEl) textareaEl.focus();
    });
  }

  function handleDeletePrompt(e, p) {
    e.stopPropagation();
    const pId = p._id || p.id;
    if (chatStore && typeof chatStore.deletePrompt === "function" && pId) {
      chatStore.deletePrompt(pId).catch(() => {});
    }
    recentPrompts = recentPrompts.filter((x) => (x._id || x.id || x) !== (pId || p));
    try {
      localStorage.setItem("krea_recent_prompts", JSON.stringify(recentPrompts));
    } catch (_) {}
  }

  function formatPromptTime(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      if (diffMins < 1) return $_("krea_time_just_now", {}, "только что");
      if (diffMins < 60) return $_("krea_time_mins_ago", { count: diffMins }, `${diffMins} мин назад`);
      if (diffHours < 24) return $_("krea_time_hours_ago", { count: diffHours }, `${diffHours} ч назад`);
      if (diffDays < 7) return $_("krea_time_days_ago", { count: diffDays }, `${diffDays} дн назад`);
      return d.toLocaleDateString();
    } catch (_) {
      return "";
    }
  }

  function handleDocumentClick(e) {
    if (showPromptsPopup && !e.target.closest(".prompts-popup") && !e.target.closest(".prompts-history-btn")) {
      showPromptsPopup = false;
    }
    if (showStyleDropdown && !e.target.closest(".style-dropdown-control")) {
      closeStyleDropdown();
    }
    if (showArchetypeDropdown && !e.target.closest(".archetype-dropdown-control")) {
      closeArchetypeDropdown();
    }
    if (showAdvancedSettings && !e.target.closest(".advanced-settings-control")) {
      closeAdvancedSettings();
    }
  }

  function handleKeydown(e) {
    if (e.key === "Escape") {
      if (deleteConfirmTarget) {
        deleteConfirmTarget = null;
      }
      if (showStyleDropdown) {
        closeStyleDropdown();
      }
      if (showArchetypeDropdown) {
        closeArchetypeDropdown();
      }
      if (showAdvancedSettings) {
        closeAdvancedSettings();
      }
      if (showPromptsPopup) {
        showPromptsPopup = false;
      }
    }
  }

  function downloadImage(item) {
    if (!item) return;
    const src = item.blobUrl || `${getFullImageUrl(item)}?download=true`;
    const a = document.createElement("a");
    a.href = src;
    a.download = item.name || "creation.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function shareImage(item) {
    if (!item) return;
    dispatch("open-file", {
      source: {
        path: item.path,
        fullPath: item.path,
        name: item.name,
        isDir: false,
        type: "image"
      }
    });
  }

  async function publishToCivitai(item) {
    if (!item) return;
    await ensureItemPromptAndTitle(item);
    if (item.prompt && navigator.clipboard) {
      try { await navigator.clipboard.writeText(item.prompt); } catch (_) {}
    }
    downloadImage(item);
    window.open("https://civitai.com/posts/create", "_blank", "noopener,noreferrer");
  }

  async function ensureItemPromptAndTitle(item) {
    if (!item) return;
    if (item.title && item.title !== item.name.replace(/\.[^.]+$/, "") && item.prompt && item.description) return;
    const readmePath = item.path.replace(/\.[^/.]+$/, "") + ".Readme.md";
    const baseName = item.name.replace(/\.[^/.]+$/, "") + ".Readme.md";
    try {
      const drive = getTargetDrive();
      let txt = "";
      if (drive && (drive.isConnected || drive.status === "connected")) {
        txt = await readDriveText(drive, readmePath).catch(() => null);
      }
      if (!txt && httpDrive && typeof httpDrive.fetch === "function") {
        const resp = await httpDrive.fetch(readmePath).catch(() => null);
        if (resp && resp.ok) txt = await resp.text().catch(() => "");
      }
      if (!txt && typeof window !== "undefined") {
        const resp = await window.fetch(`/generated/${baseName}`).catch(() => null);
        if (resp && resp.ok) txt = await resp.text().catch(() => "");
      }
      if (txt) {
        const titleMatch = txt.match(/^#\s*([^\n]+)/);
        if (titleMatch) item.title = titleMatch[1].trim();
        const promptMatch = txt.match(/<!--\s*prompt:\s*([\s\S]*?)-->/i);
        if (promptMatch) item.prompt = promptMatch[1].trim();
        const descText = txt.replace(/<!--\s*prompt:[\s\S]*?-->/gi, "").replace(/^#\s*[^\n]+\n+/, "").trim();
        item.description = descText;
        if (!item.prompt) item.prompt = descText;
      }
    } catch (_) {}
  }

  function copyPrompt(text, id) {
    if (!navigator.clipboard || !text) return;
    navigator.clipboard.writeText(text).then(() => {
      copiedPromptId = id;
      setTimeout(() => { copiedPromptId = null; }, 2000);
    });
  }

  function repeatPrompt(text, item = null) {
    if (!text) return;
    promptText = text;
    if (item?.persona) {
      const match = personas.find(
        (p) => p.name && (p.name.toLowerCase() === item.persona.toLowerCase() || item.persona.toLowerCase().includes(p.name.toLowerCase()))
      );
      if (match && !selectedPersonas.some((sp) => sp.id === match.id)) {
        selectedPersonas = [match];
      }
    }
    activeTab = "studio";
    tick().then(() => {
      if (textareaEl) {
        textareaEl.focus();
        resizeTextarea();
      }
    });
  }

  async function openGallery(activeItem) {
    const validItems = items.filter((it) => it && (it.blobUrl || it.url || it.path || it.id));
    if (!validItems.length) return;

    if (activeItem) {
      await ensureItemPromptAndTitle(activeItem);
    }

    let startIndex = 0;
    if (activeItem) {
      const idx = validItems.findIndex((it) => it.id === activeItem.id);
      if (idx !== -1) startIndex = idx;
    }

    if (lgPagination) {
      try { lgPagination.cleanup(); } catch (_) {}
      lgPagination = null;
    }
    if (lgInstance) {
      try { lgInstance.destroy(); } catch (_) {}
      lgInstance = null;
    }

    const escapeCaption = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const dynamicEl = validItems.map((it) => {
      const srcUrl = it.blobUrl || getFullImageUrl(it);
      const thumbUrl = it.blobUrl || getThumbnailUrl(it);
      const rawTitle = (it.title || "").trim();
      const rawDesc = (it.description || it.prompt || "").trim();
      const title = isJustFileName(rawTitle, it.name, it.path) ? "" : rawTitle;
      const desc = isJustFileName(rawDesc, it.name, it.path) ? "" : rawDesc;
      let descHtml = "";
      if (title && desc) {
        descHtml = `<div class="omd-gallery-caption"><h4>${escapeCaption(title)}</h4><p>${escapeCaption(desc)}</p></div>`;
      } else if (title) {
        descHtml = `<div class="omd-gallery-caption"><h4>${escapeCaption(title)}</h4></div>`;
      } else if (desc) {
        descHtml = `<div class="omd-gallery-caption"><p>${escapeCaption(desc)}</p></div>`;
      }
      return {
        src: srcUrl,
        thumb: thumbUrl,
        downloadUrl: it.blobUrl || `${getFullImageUrl(it)}?download=true`,
        subHtml: descHtml,
        title: title,
        description: desc,
        name: it.name,
        path: it.path
      };
    });

    const galleryDiv = document.createElement("div");
    document.body.appendChild(galleryDiv);

    lgPagination = setupGalleryPagination(galleryDiv, dynamicEl, startIndex);

    lgInstance = lightGallery(galleryDiv, {
      licenseKey: "GPLv3",
      dynamic: true,
      dynamicEl,
      download: true,
      counter: true,
      closable: true,
      showCloseIcon: true,
      escKey: true,
      swipeToClose: true,
      slideEndAnimation: true,
      mobileSettings: {
        controls: false,
        showCloseIcon: true,
        download: true,
      },
    });
    lgPagination.setInstance(lgInstance);

    galleryDiv.addEventListener("onCloseAfter", () => {
      try {
        if (lgPagination) lgPagination.cleanup();
        if (lgInstance) lgInstance.destroy();
      } catch (_) {}
      lgPagination = null;
      lgInstance = null;
      if (galleryDiv.parentNode) galleryDiv.parentNode.removeChild(galleryDiv);
    });

    lgInstance.openGallery(startIndex);
  }

  function initLightGallery() {
    // Gallery uses dynamic openGallery(item) modal viewer
  }

  let idleTimer = null;
  const IDLE_TIMEOUT_MS = 300000; // 5 minutes auto switch back to Creations
  let activityCleanup = null;

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!isGenerating) {
        console.log("[KreaStudio] 5 minutes idle reached, switching back to Creations");
        dispatch("switch-creations");
      } else {
        resetIdleTimer();
      }
    }, IDLE_TIMEOUT_MS);
  }

  function handleSwitchToCreations() {
    if (idleTimer) clearTimeout(idleTimer);
    dispatch("switch-creations");
  }

  onMount(async () => {
    resetIdleTimer();
    const activityEvents = ["pointerdown", "keydown", "input", "touchstart"];
    const onActivity = () => resetIdleTimer();
    activityEvents.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    activityCleanup = () => {
      activityEvents.forEach((ev) => window.removeEventListener(ev, onActivity));
    };

    if (chatStore && typeof chatStore.onPromptsChanged === "function") {
      unsubPrompts = chatStore.onPromptsChanged((list) => {
        if (Array.isArray(list) && list.length > 0) {
          recentPrompts = list;
        }
      });
    }
    try {
      const local = JSON.parse(localStorage.getItem("krea_recent_prompts") || "[]");
      if (Array.isArray(local) && local.length > 0 && recentPrompts.length === 0) {
        recentPrompts = local;
      }
    } catch (_) {}

    try {
      const fetchFn = (httpDrive && typeof httpDrive.fetch === "function")
        ? (p) => httpDrive.fetch(p)
        : (p) => fetch(p);
      fetchFn("/krea/presets").then(async (res) => {
        if (res && res.ok) {
          const data = await res.json();
          if (data && data.art_styles && data.archetypes) {
            kreaPresets = data;
          }
        }
      }).catch(() => {});
      const mcpPayload = getMcpPayload();
      fetchFn("/krea/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          omd_key: omdKey || (typeof window !== "undefined" && window.__omdKey) || "",
          mcp_keys: mcpPayload,
          settings: { mcp_keys: mcpPayload }
        })
      }).then(async (res) => {
        if (res && res.ok) {
          const data = await res.json();
          isGpuWarm = !!data.gpu_warm;
        }
      }).catch(() => {});
    } catch (_) {}

    await loadPersonas();
    await loadCreations();
    tick().then(resizeTextarea);
  });

  onDestroy(() => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (activityCleanup) {
      activityCleanup();
      activityCleanup = null;
    }
    if (driveCleanup) {
      driveCleanup();
      driveCleanup = null;
    }
    if (unsubPrompts) unsubPrompts();
    if (lgPagination) {
      try { lgPagination.cleanup(); } catch (_) {}
      lgPagination = null;
    }
    if (lgInstance) {
      try { lgInstance.destroy(true); } catch (_) {}
      lgInstance = null;
    }
    if (generationTimer) {
      clearInterval(generationTimer);
    }
  });
</script>

<svelte:window on:click={handleDocumentClick} on:keydown={handleKeydown} />

<div class="krea-studio-root {isDarkTheme ? 'dark-theme' : 'light-theme'}" class:overlay-header={isOverlayHeader}>
  <!-- Header / Top Bar -->
  <header class="studio-header">
    <div class="header-left">
      {#if !sidebarOpen}
        <button
          class="sidebar-toggle-btn"
          title="Toggle Sidebar"
          on:click={() => dispatch("toggle-sidebar")}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      {/if}

      <div class="header-mode-toggle-group">
        <div class="header-mode-toggle" role="tablist">
          <button
            type="button"
            class="mode-toggle-btn"
            title="CyberCraft (SDXL)"
            on:click={handleSwitchToCreations}
          >
            <span class="mode-icon">✨</span>
            <span class="mode-text mode-text-full">CyberCraft</span>
            <span class="mode-text mode-text-short">Cyber</span>
          </button>
          <button
            type="button"
            class="mode-toggle-btn active"
            title={$_("krea_studio", {}, "Creative Studio")}
          >
            <span class="mode-icon">⚡</span>
            <span class="mode-text mode-text-full">{$_("krea_studio", {}, "Creative Studio")}</span>
            <span class="mode-text mode-text-short">Studio</span>
          </button>
        </div>
        {#if items.length > 0}
          <span class="header-count-pill" title={$_("generated", {}, "Creations")}>
            {items.length}
          </span>
        {/if}
      </div>
    </div>

    <!-- Centered Mode Switcher: Gallery vs Personas -->
    <div class="header-tabs">
      <button
        class="tab-btn"
        class:active={activeTab === "gallery"}
        on:click={() => (activeTab = "gallery")}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span>{$_("krea_tab_gallery", {}, "Галерея")}</span>
        {#if items.length > 0}
          <span class="badge">{items.length}</span>
        {/if}
      </button>

      <button
        class="tab-btn"
        class:active={activeTab === "personas"}
        on:click={() => (activeTab = "personas")}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span>{$_("krea_tab_personas", {}, "Персоны")}</span>
        {#if personas.length > 0}
          <span class="badge">{personas.length}</span>
        {/if}
      </button>
    </div>

    <div class="header-right">
      <!-- Sort Order Toggle -->
      <button
        type="button"
        class="icon-btn sort-order-btn"
        class:is-active={sortOrder === "asc"}
        title={sortOrder === "desc" ? $_("krea_sort_desc", {}, "Дата (сначала новые)") : $_("krea_sort_asc", {}, "Дата (сначала старые)")}
        aria-label={sortOrder === "desc" ? $_("krea_sort_desc", {}, "Дата (сначала новые)") : $_("krea_sort_asc", {}, "Дата (сначала старые)")}
        on:click={toggleSortOrder}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          {#if sortOrder === "desc"}
            <path d="M4 6h9M4 12h7M4 18h5" />
            <path d="M16 15l3 3 3-3" />
            <path d="M19 6v12" />
          {:else}
            <path d="M4 6h5M4 12h7M4 18h9" />
            <path d="M16 9l3-3 3 3" />
            <path d="M19 18V6" />
          {/if}
        </svg>
      </button>

      <button
        class="icon-btn"
        class:spinning={isLoadingFiles}
        title={$_("krea_refresh", {}, "Обновить")}
        on:click={() => { loadPersonas(); loadCreations(); }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>

      <button
        class="icon-btn close-btn"
        title={$_("krea_close", {}, "Закрыть")}
        on:click={() => dispatch("close")}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  </header>

  <!-- Main Workspace -->
  <main class="studio-main">
    {#if activeTab === "personas"}
      <!-- PERSONAS VIEW -->
      <section class="personas-section" in:fade={{ duration: 150 }}>
        <div class="section-toolbar">
          <div class="section-desc">
            <h3>{$_("krea_personas_title", {}, "Библиотека персон")}</h3>
            <p>{$_("krea_personas_subtitle", {}, "Словесные паспорта и внешности персонажей, закрепляемые за генерациями")}</p>
          </div>
          <div class="toolbar-actions">
            {#if selectedPersonas.length > 0}
              <button class="go-gallery-btn" on:click={() => (activeTab = "gallery")}>
                <span>🎨 {$_("krea_to_studio", {}, "В студию")} ({selectedPersonas.length}) ➔</span>
              </button>
            {/if}
            <button class="ai-factory-btn" on:click={openAiPersonaModal}>
              <span class="btn-sparkle">✨</span> {$_("krea_ai_factory", {}, "AI Фабрика персон")}
            </button>
            <button class="create-persona-btn" on:click={openCreatePersonaModal}>
              <span>+</span> {$_("krea_create_manual", {}, "Создать вручную")}
            </button>
          </div>
        </div>

        <div class="personas-grid">
          {#each personas as p (p.id)}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              class="persona-card"
              class:selected={selectedPersonas.some((x) => x.id === p.id)}
              on:click={() => selectPersona(p)}
            >
              <div class="persona-avatar-wrap">
                {#if p.avatar}
                  <img src={p.avatar} alt={p.name} class="persona-avatar" />
                {:else}
                  <div class="persona-avatar-placeholder">
                    {p.name.slice(0, 1).toUpperCase()}
                  </div>
                {/if}
                {#if selectedPersonas.some((x) => x.id === p.id)}
                  <div class="active-check-badge">✓</div>
                {/if}
              </div>

              <div class="persona-info">
                <div class="persona-header-row">
                  <span class="persona-name">{p.name}</span>
                  {#if p.avatarData || p.avatar}
                    <span class="persona-ref-chip" title="One-Shot Face Likeness: Krea 2 Identity Edit dual conditioning">📸 One-Shot Ref</span>
                  {/if}
                  {#if p.title}
                    <span class="persona-title-chip">{p.title}</span>
                  {/if}
                </div>
                <p class="persona-passport" title={p.prompt}>{p.prompt}</p>
              </div>

              <div class="persona-actions">
                <button
                  class="card-action-btn select-btn"
                  class:active={selectedPersonas.some((x) => x.id === p.id)}
                  on:click={(e) => { e.stopPropagation(); selectPersona(p); }}
                >
                  {selectedPersonas.some((x) => x.id === p.id) ? "✓ " + $_("krea_persona_selected", {}, "Выбрана") : "+ " + $_("krea_persona_select", {}, "Выбрать")}
                </button>
                <button
                  class="card-action-btn icon-only"
                  title={$_("krea_persona_edit", {}, "Редактировать")}
                  on:click={(e) => { e.stopPropagation(); openEditPersonaModal(p); }}
                >
                  ✎
                </button>
                <button
                  class="card-action-btn icon-only danger"
                  title={$_("krea_persona_delete", {}, "Удалить")}
                  on:click={(e) => deletePersona(p, e)}
                >
                  ✕
                </button>
              </div>
            </div>
          {/each}

          <!-- New Persona Card Slot -->
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div class="persona-card add-new-slot" on:click={openAiPersonaModal}>
            <div class="add-slot-circle">✨</div>
            <span class="add-slot-label">{$_("krea_ai_factory", {}, "AI Фабрика персон")}</span>
            <span class="add-slot-hint">{$_("krea_factory_hint", {}, "Создать по типажу в 1 клик")}</span>
          </div>
        </div>
      </section>
    {:else}
      <!-- GALLERY VIEW -->
      <section
        class="gallery-section"
        bind:this={scrollContainerEl}
        in:fade={{ duration: 150 }}
      >
        {#if items.length === 0 && !isGenerating}
          <div class="empty-gallery">
            <div class="empty-icon">🎨</div>
            <h3>{$_("krea_no_creations_title", {}, "Пока нет генераций в студии")}</h3>
            <p>{$_("krea_no_creations_desc", {}, "Введите промпт внизу или выберите персону и нажмите \"Сгенерировать\". Скорость рендера ~4 сек!")}</p>
            <div class="empty-suggestions">
              {#each promptSuggestions as sug}
                <button class="sug-pill" on:click={() => { promptText = sug; }}>
                  "{sug}"
                </button>
              {/each}
            </div>
          </div>
        {:else}
          <div class="gallery-grid">
            {#if isGenerating}
              <div class="gallery-card placeholder-card">
                <div
                  class="placeholder-preview"
                  style={`aspect-ratio: ${sliders.aspect.replace('x', ' / ')};`}
                >
                  <div class="shimmer-mesh"></div>
                  <div class="glow-orb"></div>
                  <div class="placeholder-content">
                    <div class="status-pill">
                      <span class="pulse-dot"></span>
                      {#if generatingStage === "warming"}
                        <span class="status-text">⚡ {$_("krea_stage_warming", {}, "Пробуждение GPU")} {generationElapsed}s</span>
                      {:else if generatingStage === "generating"}
                        <span class="status-text">🎨 {$_("krea_stage_generating", {}, "AI генерация")} {generationElapsed}s</span>
                      {:else}
                        <span class="status-text">📥 {$_("krea_stage_saving", {}, "Сохранение")} {generationElapsed}s</span>
                      {/if}
                    </div>
                    <p class="placeholder-prompt" title={generatingPrompt}>{generatingPrompt}</p>
                    <div class="placeholder-progress-bar">
                      <div class="progress-bar-fill" class:downloading={generatingStage === "saving"}></div>
                    </div>
                  </div>
                </div>
                <div class="card-footer-info placeholder-footer">
                  <span class="card-title">
                    {#if generatingStage === "warming"}
                      {$_("krea_stage_warming_hint", {}, "Инициализация A100 GPU и загрузка весов в память...")}
                    {:else if generatingStage === "generating"}
                      {$_("krea_stage_generating_hint", {}, "Отрисовка нейросетью (6 шагов)...")}
                    {:else}
                      {$_("krea_stage_saving_hint", {}, "Запись файла и подготовка кадра...")}
                    {/if}
                  </span>
                  {#if generatingPersona}
                    <span class="persona-tag">👤 {generatingPersona}</span>
                  {/if}
                </div>
              </div>
            {/if}
            {#each items as item (item.id)}
              <div class="gallery-card">
                <!-- svelte-ignore a11y-click-events-have-key-events -->
                <!-- svelte-ignore a11y-no-static-element-interactions -->
                <div
                  class="gallery-card-thumb-wrap"
                  role="button"
                  tabindex="0"
                  on:click={() => openGallery(item)}
                  on:keydown={(e) => e.key === "Enter" && openGallery(item)}
                >
                  <img
                    src=""
                    alt={item.title || item.prompt}
                    use:lazyLoad={getThumbnailUrl(item)}
                    class="gallery-thumb"
                    loading="lazy"
                    on:error={(e) => handleImageError(item, e)}
                  />
                </div>
                <div class="card-footer-info">
                  <div class="card-meta">
                    <span class="card-title" title={item.title || item.prompt}>{item.title || item.prompt}</span>
                    {#if item.persona}
                      <span class="persona-tag">👤 {item.persona}</span>
                    {/if}
                    {#if item.totalTime}
                      <span class="card-time-tag" title={$_("krea_total_time", { total: item.totalTime, gpu: item.gpuTime ? `, GPU: ${item.gpuTime}s` : "" }, `Полное время: ${item.totalTime}s${item.gpuTime ? `, генерация GPU: ${item.gpuTime}s` : ""}`)}>
                        ⚡ {item.totalTime}s{#if item.gpuTime}<span class="gpu-sub">({item.gpuTime}s)</span>{/if}
                      </span>
                    {/if}
                  </div>
                  <div class="card-toolbar">
                    {#if item.prompt || item.title}
                      <button
                        type="button"
                        class="toolbar-btn"
                        class:copied={copiedPromptId === item.id}
                        title={$_("copy_prompt", {}, "Копировать промпт")}
                        on:click|stopPropagation={() => copyPrompt(item.prompt || item.title, item.id)}
                      >
                        {#if copiedPromptId === item.id}
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#10b981" stroke-width="2.5">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        {:else}
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        {/if}
                      </button>

                      <button
                        type="button"
                        class="toolbar-btn"
                        title={$_("repeat_prompt", {}, "Повторить промпт")}
                        on:click|stopPropagation={() => repeatPrompt(item.prompt || item.title, item)}
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="1 4 1 10 7 10" />
                          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                        </svg>
                      </button>
                    {/if}

                    <button
                      type="button"
                      class="toolbar-btn"
                      title={$_("download", {}, "Скачать")}
                      on:click|stopPropagation={() => downloadImage(item)}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>

                    <button
                      type="button"
                      class="toolbar-btn"
                      title={$_("share", {}, "Поделиться")}
                      on:click|stopPropagation={() => shareImage(item)}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="18" cy="5" r="3" />
                        <circle cx="6" cy="12" r="3" />
                        <circle cx="18" cy="19" r="3" />
                        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                      </svg>
                    </button>

                    {#if hasCivitaiToken}
                      <button
                        type="button"
                        class="toolbar-btn civitai-publish-btn"
                        title={$_("publish_civitai", {}, "Publish to CivitAI")}
                        on:click|stopPropagation={() => publishToCivitai(item)}
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                      </button>
                    {/if}

                    <button
                      type="button"
                      class="toolbar-btn card-ref-btn"
                      title={$_("krea_use_as_ref", {}, "Использовать как референс")}
                      on:click|stopPropagation={() => addGalleryItemAsReference(item)}
                    >
                      📷
                    </button>
                    <button
                      type="button"
                      class="toolbar-btn card-delete-btn"
                      title={$_("krea_persona_delete", {}, "Удалить")}
                      on:click|stopPropagation={(e) => deleteCreation(item, e)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  </main>

  <!-- Sticky Bottom Generation Composer with Sliders -->
  <footer class="studio-composer">
    <!-- Selected Persona & Sliders Row -->
    <div class="composer-controls-row">
      <!-- Active Personas Group -->
      {#if selectedPersonas.length > 0}
        <div class="active-personas-wrap">
          {#each selectedPersonas as p (p.id)}
            <div class="active-persona-pill" in:fade={{ duration: 100 }}>
              <span class="pill-avatar-icon">👤</span>
              <span class="pill-name">{p.name}</span>
              <button class="pill-clear-btn" title={$_("krea_clear_persona", { name: p.name }, `Сбросить ${p.name}`)} on:click={() => removeSelectedPersona(p.id)}>
                ✕
              </button>
            </div>
          {/each}
          <button class="add-more-personas-btn" title={$_("krea_add_more_personas", {}, "Добавить еще персону")} on:click={() => (activeTab = "personas")}>
            {$_("krea_add_more", {}, "+ Еще")}
          </button>
        </div>
      {:else}
        <button class="pick-persona-btn" on:click={() => (activeTab = "personas")}>
          {$_("krea_pick_persona", {}, "+ Выбрать персону")}
        </button>
      {/if}

      <div class="composer-controls-right">
        <!-- Tags Preview Toggle Button -->
        <button
          type="button"
          class="toggle-tokens-btn"
          class:open={showPromptTokensPreview}
          class:active={showPromptTokensPreview}
          title={$_("krea_toggle_tags_title", {}, "Показать/скрыть теги")}
          on:click={() => (showPromptTokensPreview = !showPromptTokensPreview)}
        >
          <span>{$_("krea_show_tags", {}, "Теги")}</span>
          <span class="pill-chevron">{showPromptTokensPreview ? "▼" : "▲"}</span>
        </button>

        <!-- Parameters Toggle Button -->
        <button
          class="toggle-sliders-btn"
          class:open={showSlidersPanel}
          on:click={() => (showSlidersPanel = !showSlidersPanel)}
        >
          <span>{$_("krea_params_sliders", {}, "Параметры")}</span>
          <span class="pill-chevron">{showSlidersPanel ? "▼" : "▲"}</span>
        </button>

        <!-- Gear Settings Control (Extreme Right) -->
        <div class="advanced-settings-control" class:active={showAdvancedSettings}>
          <button
            type="button"
            class="advanced-gear-btn"
            class:active={showAdvancedSettings}
            title={$_("krea_advanced_gear_title", {}, "Параметры генерации: Шаги, CFG, Детализация")}
            on:click={(e) => {
              e.stopPropagation();
              showAdvancedSettings = !showAdvancedSettings;
              if (showAdvancedSettings) {
                showStyleDropdown = false;
                showArchetypeDropdown = false;
              }
            }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <span class="gear-summary-text">{sliders.steps} {$_("krea_steps_short", {}, "ш.")} / {sliders.cfg} cfg</span>
            <span class="pill-chevron">{showAdvancedSettings ? "▼" : "▲"}</span>
          </button>

          {#if showAdvancedSettings}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div class="dropdown-popup-menu advanced-popup" transition:fade={{ duration: 100 }} on:click|stopPropagation>
              <div class="popup-menu-header">
                <span>{$_("krea_advanced_settings", {}, "Параметры генерации")}</span>
                <button
                  type="button"
                  class="popup-reset-link"
                  on:click={resetAdvancedToModelDefaults}
                  title={$_("krea_advanced_reset_title", {}, "Сбросить к рекомендованным значениям для выбранной модели")}
                >
                  {$_("krea_reset", {}, "Сбросить")}
                </button>
              </div>

              <div class="advanced-popup-body">
                <!-- Setting 1: Detail Slider -->
                <div class="advanced-setting-row">
                  <div class="setting-title-row">
                    <span class="setting-name">{$_("krea_detail_label", {}, "Детализация (Detail):")}</span>
                    <span class="setting-val-badge">{sliders.detail > 0 ? `+${sliders.detail}` : sliders.detail}</span>
                  </div>
                  <input
                    type="range"
                    min="0.0"
                    max="1.0"
                    step="0.1"
                    bind:value={sliders.detail}
                    on:input={() => { sliders = { ...sliders }; saveLocalSliders(sliders); }}
                    class="slider-input advanced-slider"
                  />
                  <div class="setting-subtext">
                    <span>{$_("krea_detail_soft", {}, "Мягко (0.0)")}</span>
                    <span>{$_("krea_detail_normal", {}, "Норма (0.5)")}</span>
                    <span>{$_("krea_detail_ultra", {}, "Чётко (1.0)")}</span>
                  </div>
                </div>

                <!-- Setting 2: Steps Slider -->
                <div class="advanced-setting-row">
                  <div class="setting-title-row">
                    <span class="setting-name">{$_("krea_steps", {}, "Шаги (Steps):")}</span>
                    <span class="setting-val-badge">{sliders.steps} {sliders.steps <= 8 ? "(Turbo)" : ""}</span>
                  </div>
                  <input
                    type="range"
                    min="4"
                    max="30"
                    step="1"
                    bind:value={sliders.steps}
                    on:input={() => { sliders = { ...sliders }; saveLocalSliders(sliders); }}
                    class="slider-input advanced-slider"
                  />
                  <div class="setting-subtext">
                    <span>4 ({$_("krea_steps_fast", {}, "Быстро")})</span>
                    <span>6 (Turbo)</span>
                    <span>14 ({$_("krea_steps_quality", {}, "Качество")})</span>
                    <span>25 (Anima)</span>
                  </div>
                </div>

                <!-- Setting 3: CFG Scale -->
                <div class="advanced-setting-row">
                  <div class="setting-title-row">
                    <span class="setting-name">{$_("krea_cfg", {}, "Сила промпта (CFG Scale):")}</span>
                    <span class="setting-val-badge">{sliders.cfg}</span>
                  </div>
                  <input
                    type="range"
                    min="1.0"
                    max="7.0"
                    step="0.5"
                    bind:value={sliders.cfg}
                    on:input={() => { sliders = { ...sliders }; saveLocalSliders(sliders); }}
                    class="slider-input advanced-slider"
                  />
                  <div class="setting-subtext">
                    <span>1.0 ({$_("krea_cfg_soft", {}, "Мягко")})</span>
                    <span>1.5 ({$_("krea_realism", {}, "Реализм")})</span>
                    <span>2.0 ({$_("krea_semi_realism", {}, "Полуреализм")})</span>
                    <span>3.0 ({$_("krea_anima", {}, "Анима")})</span>
                  </div>
                </div>
              </div>

              <div class="popup-menu-footer">
                <span class="popup-count-hint">{$_("krea_model_label", {}, "Модель:")} {sliders.base_model === "anima" ? $_("krea_anima", {}, "Анима") : (sliders.base_model === "semi_realism" ? $_("krea_semi_realism", {}, "Полуреализм") : $_("krea_realism", {}, "Реализм"))}</span>
                <button
                  type="button"
                  class="popup-done-btn"
                  on:click={closeAdvancedSettings}
                >
                  {$_("krea_done", {}, "Готово")}
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Sliders and Style Presets Panel -->
    {#if showSlidersPanel}
      <div class="sliders-panel" in:fade={{ duration: 120 }}>
        <!-- Card 1: Base Model -->
        <div class="param-card model-card">
          <div class="model-pill-control">
            <div class="model-pill-header">
              <span>{$_("krea_base_model", {}, "Базовая модель")}</span>
              <span class="model-pill-hint">
                {sliders.base_model === "anima" ? "Anima V1.1" : (sliders.base_model === "semi_realism" ? "Muse Yogi" : "CyberReal")}
              </span>
            </div>
            <div class="pill-toggle-wrapper">
              <button
                type="button"
                class="pill-btn"
                class:active={sliders.base_model === "realism"}
                on:click={() => setBaseModel("realism")}
                title={$_("krea_realism_title", {}, "CyberRealistic Krea 2 — бескомпромиссный фотореализм")}
              >
                <span class="pill-icon">📸</span>
                <span>{$_("krea_realism", {}, "Реализм")}</span>
              </button>
              <button
                type="button"
                class="pill-btn"
                class:active={sliders.base_model === "semi_realism"}
                on:click={() => setBaseModel("semi_realism")}
                title={$_("krea_semi_realism_title", {}, "Muse by Stable Yogi — 2.5D / Semi-realism, мягкий киношный свет и комиксы")}
              >
                <span class="pill-icon">🎨</span>
                <span>{$_("krea_semi_realism", {}, "Полуреализм")}</span>
              </button>
              <button
                type="button"
                class="pill-btn"
                class:active={sliders.base_model === "anima"}
                on:click={() => setBaseModel("anima")}
                title={$_("krea_anima_title", {}, "Anima Aesthetic V1.1 — аутентичный аниме и традиционный 2D арт от CircleStone Labs & Comfy Org")}
              >
                <span class="pill-icon">🌸</span>
                <span>{$_("krea_anima", {}, "Анима")}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Card 2: Art Style (Multi-select with inline LoRA sliders) -->
        <div class="param-card style-card">
          <div class="dropdown-control style-dropdown-control" class:active={showStyleDropdown}>
            <span class="select-label">{$_("krea_art_style", {}, "Стиль арта:")}</span>
            <button
              type="button"
              class="dropdown-trigger-btn"
              class:has-style={(sliders.styles || []).length > 0}
              class:active={showStyleDropdown}
              on:click={(e) => {
                e.stopPropagation();
                showStyleDropdown = !showStyleDropdown;
                if (showStyleDropdown) showArchetypeDropdown = false;
              }}
            >
              <span class="trigger-label">{activeStyleLabel}</span>
              <svg class="chevron" class:open={showStyleDropdown} viewBox="0 0 20 20" fill="currentColor" width="13" height="13">
                <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
              </svg>
            </button>

            {#if showStyleDropdown}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <div class="dropdown-popup-menu style-popup" transition:fade={{ duration: 100 }} on:click|stopPropagation>
                <div class="popup-menu-header">
                  <span>{$_("krea_image_style", {}, "Стили изображения / LoRA")}</span>
                  {#if (sliders.styles || []).length > 0}
                    <button
                      type="button"
                      class="popup-reset-link"
                      on:click={() => { sliders.styles = []; sliders.style = "none"; sliders = { ...sliders }; saveLocalSliders(sliders); }}
                    >
                      {$_("krea_reset", {}, "Сбросить")}
                    </button>
                  {/if}
                </div>
                <div class="popup-options-list">
                  <button
                    type="button"
                    class="popup-option-item"
                    class:selected={(sliders.styles || []).length === 0}
                    on:click={() => { sliders.styles = []; sliders.style = "none"; sliders = { ...sliders }; saveLocalSliders(sliders); }}
                  >
                    <div class="option-check-icon radio" class:checked={(sliders.styles || []).length === 0}>
                      {#if (sliders.styles || []).length === 0}
                        <svg class="check-svg" viewBox="0 0 24 24" width="11" height="11">
                          <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                        </svg>
                      {/if}
                    </div>
                    <div class="option-main">
                      <span class="option-label">✨ {$_("krea_free_style", {}, "Свободный")}</span>
                      <span class="option-desc">{$_("krea_free_style_desc", {}, "Без LoRA (управляется текстом промпта)")}</span>
                    </div>
                  </button>

                  {#each stylePresets as sp}
                    {#if sp.id !== "none"}
                      {@const isChecked = (sliders.styles || []).includes(sp.id)}
                      <div class="popup-option-card" class:selected={isChecked}>
                        <button
                          type="button"
                          class="popup-option-row"
                          on:click={() => toggleStyle(sp.id, false)}
                        >
                          <!-- svelte-ignore a11y-click-events-have-key-events -->
                          <!-- svelte-ignore a11y-no-static-element-interactions -->
                          <div
                            class="option-check-icon checkbox"
                            class:checked={isChecked}
                            title={$_("krea_multiselect_tooltip", {}, "Мультивыбор (добавить/убрать)")}
                            on:click|stopPropagation={() => toggleStyle(sp.id, true)}
                          >
                            {#if isChecked}
                              <svg class="check-svg" viewBox="0 0 24 24" width="11" height="11">
                                <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                              </svg>
                            {/if}
                          </div>
                          <div class="option-main">
                            <span class="option-label">{sp.label}</span>
                            <span class="option-desc">{sp.desc}</span>
                          </div>
                        </button>
                        {#if isChecked && sp.lora}
                          <!-- svelte-ignore a11y-click-events-have-key-events -->
                          <!-- svelte-ignore a11y-no-static-element-interactions -->
                          <div class="option-inline-slider-row" on:click|stopPropagation on:mousedown|stopPropagation>
                            <input
                              type="range"
                              min="0.1"
                              max="1.0"
                              step="0.05"
                              value={sliders.style_weights?.[sp.id] ?? sp.strength ?? 0.8}
                              on:input={(e) => updateStyleWeight(sp.id, parseFloat(e.target.value))}
                              class="inline-weight-slider"
                            />
                            <span class="inline-weight-val">
                              {sliders.style_weights?.[sp.id] ?? sp.strength ?? 0.8}
                            </span>
                          </div>
                        {/if}
                      </div>
                    {/if}
                  {/each}
                </div>
                <div class="popup-menu-footer">
                  <span class="popup-count-hint">{$_("krea_selected_count", { count: (sliders.styles || []).length }, `Выбрано: ${(sliders.styles || []).length}`)}</span>
                  <button
                    type="button"
                    class="popup-done-btn"
                    on:click={closeStyleDropdown}
                  >
                    {$_("krea_done", {}, "Готово")}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        </div>

        <!-- Card 3: Archetype / Character LoRA (Multi-select with inline LoRA sliders) -->
        <div class="param-card archetype-card">
          <div class="dropdown-control archetype-dropdown-control" class:active={showArchetypeDropdown}>
            <span class="select-label">{$_("krea_archetype_lora", {}, "Типаж / LoRA:")}</span>
            <button
              type="button"
              class="dropdown-trigger-btn"
              class:has-archetype={(sliders.archetypes || []).length > 0}
              class:active={showArchetypeDropdown}
              on:click={(e) => {
                e.stopPropagation();
                showArchetypeDropdown = !showArchetypeDropdown;
                if (showArchetypeDropdown) showStyleDropdown = false;
              }}
            >
              <span class="trigger-label">{activeArchetypeLabel}</span>
              <svg class="chevron" class:open={showArchetypeDropdown} viewBox="0 0 20 20" fill="currentColor" width="13" height="13">
                <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
              </svg>
            </button>

            {#if showArchetypeDropdown}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <div class="dropdown-popup-menu archetype-popup" transition:fade={{ duration: 100 }} on:click|stopPropagation>
                <div class="popup-menu-header">
                  <span>{$_("krea_appearance_lora", {}, "Типажи внешности / LoRA")}</span>
                  {#if (sliders.archetypes || []).length > 0}
                    <button
                      type="button"
                      class="popup-reset-link"
                      on:click={() => { sliders.archetypes = []; sliders.archetype = null; sliders = { ...sliders }; saveLocalSliders(sliders); }}
                    >
                      {$_("krea_reset", {}, "Сбросить")}
                    </button>
                  {/if}
                </div>
                <div class="popup-options-list">
                  <button
                    type="button"
                    class="popup-option-item"
                    class:selected={(sliders.archetypes || []).length === 0}
                    on:click={() => { sliders.archetypes = []; sliders.archetype = null; sliders = { ...sliders }; saveLocalSliders(sliders); }}
                  >
                    <div class="option-check-icon radio" class:checked={(sliders.archetypes || []).length === 0}>
                      {#if (sliders.archetypes || []).length === 0}
                        <svg class="check-svg" viewBox="0 0 24 24" width="11" height="11">
                          <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                        </svg>
                      {/if}
                    </div>
                    <div class="option-main">
                      <span class="option-label">✨ {$_("krea_free_style", {}, "Свободный")}</span>
                      <span class="option-desc">{$_("krea_free_style_desc", {}, "Без LoRA (управляется текстом промпта)")}</span>
                    </div>
                  </button>
                  {#each archetypePresets as ap}
                    {@const isChecked = (sliders.archetypes || []).includes(ap.id)}
                    <div class="popup-option-card archetype-item" class:selected={isChecked}>
                      <button
                        type="button"
                        class="popup-option-row"
                        on:click={() => toggleArchetype(ap.id, false)}
                      >
                        <!-- svelte-ignore a11y-click-events-have-key-events -->
                        <!-- svelte-ignore a11y-no-static-element-interactions -->
                        <div
                          class="option-check-icon checkbox"
                          class:checked={isChecked}
                          title={$_("krea_multiselect_tooltip", {}, "Мультивыбор (добавить/убрать)")}
                          on:click|stopPropagation={() => toggleArchetype(ap.id, true)}
                        >
                          {#if isChecked}
                            <svg class="check-svg" viewBox="0 0 24 24" width="11" height="11">
                              <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                            </svg>
                          {/if}
                        </div>
                        <div class="option-main">
                          <span class="option-label">{ap.label}</span>
                          <span class="option-desc">{ap.desc}</span>
                        </div>
                      </button>
                      {#if isChecked && ap.lora}
                        <!-- svelte-ignore a11y-click-events-have-key-events -->
                        <!-- svelte-ignore a11y-no-static-element-interactions -->
                        <div class="option-inline-slider-row" on:click|stopPropagation on:mousedown|stopPropagation>
                          <input
                            type="range"
                            min="0.1"
                            max="1.0"
                            step="0.05"
                            value={sliders.archetype_weights?.[ap.id] ?? ap.strength ?? 0.8}
                            on:input={(e) => updateArchetypeWeight(ap.id, parseFloat(e.target.value))}
                            class="inline-weight-slider"
                          />
                          <span class="inline-weight-val">
                            {sliders.archetype_weights?.[ap.id] ?? ap.strength ?? 0.8}
                          </span>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
                <div class="popup-menu-footer">
                  <span class="popup-count-hint">{$_("krea_selected_count", { count: (sliders.archetypes || []).length }, `Выбрано: ${(sliders.archetypes || []).length}`)}</span>
                  <button
                    type="button"
                    class="popup-done-btn"
                    on:click={closeArchetypeDropdown}
                  >
                    {$_("krea_done", {}, "Готово")}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        </div>

        <!-- Card 4: Aspect Ratio -->
        <div class="param-card aspect-settings-card">
          <div class="card-header-row">
            <span class="select-label">{$_("krea_aspect_ratio", {}, "Формат:")}</span>
          </div>

          <div class="aspect-chips">
            <button
              type="button"
              class="aspect-chip"
              class:active={sliders.aspect === "896x1152"}
              on:click={() => setAspect("896x1152")}
              title={$_("krea_aspect_portrait", {}, "3:4 Портрет (896x1152)")}
            >
              📱 3:4
            </button>
            <button
              type="button"
              class="aspect-chip"
              class:active={sliders.aspect === "1024x1024"}
              on:click={() => setAspect("1024x1024")}
              title={$_("krea_aspect_square", {}, "1:1 Квадрат (1024x1024)")}
            >
              ⏹ 1:1
            </button>
            <button
              type="button"
              class="aspect-chip"
              class:active={sliders.aspect === "1152x896"}
              on:click={() => setAspect("1152x896")}
              title={$_("krea_aspect_landscape", {}, "4:3 Альбомный (1152x896)")}
            >
              🖥 4:3
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Prompts History Popup -->
    {#if showPromptsPopup}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
      <div class="prompts-popup" role="dialog" tabindex="-1">
        <div class="prompts-popup-header">
          <div class="prompts-header-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>{$_("krea_prompt_history", {}, "История промптов")}</span>
          </div>
          <button
            type="button"
            class="prompts-popup-close"
            on:click={() => (showPromptsPopup = false)}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {#if recentPrompts.length > 5}
          <div class="prompts-search-wrap">
            <input
              type="text"
              class="prompts-search-input"
              placeholder={$_("krea_search_history", {}, "Поиск в истории...")}
              bind:value={promptsSearchQuery}
            />
          </div>
        {/if}

        <div class="prompts-popup-list">
          {#each filteredPrompts as p}
            <div class="prompt-item" on:click={() => selectPrompt(p)}>
              <div class="prompt-item-content">
                <div class="prompt-item-text">{p.text || p.prompt || p}</div>
                <div class="prompt-item-meta">
                  {#if p.style}
                    <span class="prompt-style-badge">{p.style}</span>
                  {/if}
                  <span class="prompt-time">{formatPromptTime(p.lastUsed || p.created || p.date)}</span>
                </div>
              </div>
              <button
                type="button"
                class="prompt-delete-btn"
                title={$_("krea_persona_delete", {}, "Удалить")}
                on:click={(e) => handleDeletePrompt(e, p)}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          {:else}
            <div class="prompts-empty-state">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>{$_("krea_no_recent_prompts", {}, "Нет недавних промптов")}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Active Modifiers & Prompt Preview Bar -->
    {#if selectedPersonas.length > 0 || activeStyleObjs.some(s => s.id !== "none") || activeArchetypeObjs.length > 0}
      <div class="active-modifiers-bar">
        {#each selectedPersonas as p (p.id)}
          <div class="active-pill persona-pill" in:fade={{ duration: 100 }} title={$_("krea_active_passport", {}, "Активный словесный паспорт")}>
            <span class="pill-icon">👤</span>
            <span class="pill-text">{p.name}</span>
            <button
              type="button"
              class="pill-remove-btn"
              title={$_("krea_clear_persona", { name: p.name }, `Сбросить ${p.name}`)}
              on:click|stopPropagation={() => removeSelectedPersona(p.id)}
            >✕</button>
          </div>
        {/each}

        {#each activeStyleObjs as sp (sp.id)}
          {#if sp.id !== "none"}
            <div class="active-pill style-pill" in:fade={{ duration: 100 }} title={sp.desc}>
              <span class="pill-text">{sp.label} {sliders.style_weights?.[sp.id] !== undefined ? `(${sliders.style_weights[sp.id]})` : (sp.strength ? `(${sp.strength})` : "")}</span>
              <button
                type="button"
                class="pill-remove-btn"
                title={$_("krea_remove_style", { name: sp.name || sp.label }, `Убрать стиль ${sp.label}`)}
                on:click|stopPropagation={() => toggleStyle(sp.id)}
              >✕</button>
            </div>
          {/if}
        {/each}

        {#each activeArchetypeObjs as ap (ap.id)}
          <div class="active-pill archetype-pill" in:fade={{ duration: 100 }} title={ap.desc}>
            <span class="pill-text">{ap.label} {sliders.archetype_weights?.[ap.id] !== undefined ? `(${sliders.archetype_weights[ap.id]})` : (ap.strength ? `(${ap.strength})` : "")}</span>
            <button
              type="button"
              class="pill-remove-btn"
              title={$_("krea_remove_archetype", { name: ap.name || ap.label }, `Сбросить типаж LoRA ${ap.label}`)}
              on:click|stopPropagation={() => toggleArchetype(ap.id)}
            >✕</button>
          </div>
        {/each}
      </div>
    {/if}

    {#if showPromptTokensPreview}
      <div class="tokens-preview-panel" transition:fly={{ y: 6, duration: 150 }}>
        <div class="tokens-preview-header">
          <span class="preview-title">⚡ {$_("krea_final_pipeline", {}, "Итоговый пайплайн:")}</span>
        </div>
        <div class="tokens-preview-body">
          {#if selectedPersonas.length > 0}
            {#each selectedPersonas as p}
              <div class="token-row">
                <span class="token-badge token-badge-persona">👤 {$_("krea_passport_badge", {}, "Паспорт")} ({p.name})</span>
                <span class="token-text">{p.prompt}</span>
              </div>
              {#if p.avatarData || p.avatar}
                <div class="token-row">
                  <span class="token-badge token-badge-ref">📸 One-Shot Face Ref ({p.name})</span>
                  <span class="token-text">Krea 2 Identity Edit (native dual-conditioning likeness active)</span>
                </div>
              {/if}
            {/each}
          {/if}
          {#if activeStyleTokens}
            <div class="token-row">
              <span class="token-badge token-badge-style">🎨 {$_("krea_style_badge", {}, "Стиль")} ({activeStyleLabel})</span>
              <span class="token-text">{activeStyleTokens}</span>
            </div>
          {/if}
          {#if activeArchetypeObjs.length > 0}
            {#each activeArchetypeObjs as ap}
              <div class="token-row">
                <span class="token-badge token-badge-archetype">🧬 LoRA ({ap.label})</span>
                <span class="token-text">{getArchetypeToken(ap.id)}</span>
              </div>
            {/each}
          {/if}
          <div class="token-row">
            <span class="token-badge token-badge-user">✍️ {$_("krea_prompt_badge", {}, "Сюжет")}</span>
            <span class="token-text">{promptText.trim() || $_("krea_prompt_empty_hint", {}, "(пусто — введите желаемое действие или локацию)")}</span>
          </div>
        </div>
      </div>
    {/if}

    <!-- Attached Reference Images Bar -->
    {#if attachedReferences.length > 0}
      <div class="attached-refs-bar">
        <span class="refs-label">{$_("krea_refs_count", { count: attachedReferences.length }, `Референсы (${attachedReferences.length}/2):`)}</span>
        <div class="refs-list">
          {#each attachedReferences as ref, idx}
            <div class="ref-chip">
              <span class="ref-chip-idx">#{idx + 1}</span>
              <img src={ref.preview} alt={$_("krea_ref_img", { idx: idx + 1 }, `Картинка ${idx + 1}`)} class="ref-chip-img" />
              <span class="ref-chip-title" title={ref.name || $_("krea_ref_img", { idx: idx + 1 }, `Картинка ${idx + 1}`)}>{ref.name || $_("krea_ref_img", { idx: idx + 1 }, `Картинка ${idx + 1}`)}</span>
              <button
                type="button"
                class="ref-chip-del"
                title={$_("krea_delete_ref", {}, "Удалить референс")}
                on:click={() => removeReference(idx)}
              >✕</button>
            </div>
          {/each}
          {#if attachedReferences.length < 2}
            <button
              type="button"
              class="add-ref-mini-btn"
              title={$_("krea_add_more_refs", {}, "Добавить ещё референс")}
              on:click={() => refFileInputEl?.click()}
            >
              {$_("krea_add_ref_btn", {}, "+ Ещё картинка")}
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Prompt Textarea and Actions -->
    <div class="composer-input-row">
      <textarea
        bind:this={textareaEl}
        bind:value={promptText}
        placeholder={$_("krea_prompt_placeholder", {}, "Опишите изображение...")}
        rows="1"
        class="prompt-textarea"
        on:input={resizeTextarea}
        on:keydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            runGeneration();
          }
        }}
      ></textarea>

      <div class="composer-actions">
        <!-- Hidden file input for references -->
        <input
          type="file"
          bind:this={refFileInputEl}
          accept="image/png,image/jpeg,image/webp"
          on:change={handleRefFileSelected}
          style="display: none;"
        />

        <!-- Add Image Reference Button (max 2) -->
        <button
          type="button"
          class="attach-ref-btn"
          class:active={attachedReferences.length > 0}
          disabled={attachedReferences.length >= 2 || isUploadingRef}
          title={attachedReferences.length >= 2 ? $_("krea_attach_ref_max", {}, "Прикреплено 2 референса (максимум)") : $_("krea_attach_ref_title", {}, "Добавить картинку-референс (до 2 штук)")}
          on:click={() => refFileInputEl?.click()}
        >
          {#if isUploadingRef}
            <svg class="spin-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
            </svg>
          {:else}
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          {/if}
          {#if attachedReferences.length > 0}
            <span class="ref-badge-num">{attachedReferences.length}</span>
          {/if}
        </button>

        <button
          type="button"
          class="prompts-history-btn"
          class:active={showPromptsPopup}
          title={$_("krea_prompt_history", {}, "История промптов")}
          on:click|stopPropagation={() => (showPromptsPopup = !showPromptsPopup)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </button>

        <button
          type="button"
          class="random-idea-btn"
          class:spinning={isRandomizingPrompt}
          disabled={isRandomizingPrompt}
          title={$_("krea_random_idea", {}, "Случайная идея (AI)")}
          on:click={pickRandomSuggestion}
        >
          <span class="dice-icon">🎲</span>
        </button>

        <button
          class="generate-submit-btn"
          class:busy={isGenerating}
          disabled={isGenerating || (!promptText.trim() && selectedPersonas.length === 0)}
          on:click={runGeneration}
        >
          {#if isGenerating}
            <div class="spinner"></div>
            {#if generatingStage === "warming"}
              <span>{$_("krea_warming", {}, "Прогрев")} {generationElapsed}s</span>
            {:else if generatingStage === "saving"}
              <span>{$_("krea_saving", {}, "Сохранение")} {generationElapsed}s</span>
            {:else}
              <span>{$_("krea_generating", {}, "Генерация")} {generationElapsed}s</span>
            {/if}
          {:else}
            <span class="btn-sparkle">✨</span>
            <span>{$_("krea_generate_btn", {}, "Сгенерировать")}</span>
          {/if}
        </button>
      </div>
    </div>
  </footer>

  <!-- Modal: Manual Create/Edit Persona -->
  {#if showPersonaModal}
    <div class="modal-backdrop" on:click={() => (showPersonaModal = false)}>
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="persona-modal-card" on:click|stopPropagation>
        <div class="modal-header">
          <h3>{editingPersonaId ? $_("krea_edit_persona", {}, "Редактировать персону") : $_("krea_new_persona", {}, "Новая персона")}</h3>
          <button class="modal-close-btn" on:click={() => (showPersonaModal = false)}>✕</button>
        </div>

        <div class="modal-body">
          <div class="modal-field">
            <label for="p-name">{$_("krea_persona_name", {}, "Имя персоны:")}</label>
            <input
              id="p-name"
              type="text"
              placeholder={$_("krea_persona_name_placeholder", {}, "например: Кира, Alex, June...")}
              bind:value={personaFormName}
              class="modal-input"
            />
          </div>

          <div class="modal-field">
            <label for="p-title">{$_("krea_persona_role", {}, "Амплуа / Роль:")}</label>
            <input
              id="p-title"
              type="text"
              placeholder={$_("krea_persona_role_placeholder", {}, "например: Alt Girl, Tech Lead, Фотомодель...")}
              bind:value={personaFormTitle}
              class="modal-input"
            />
          </div>

          <div class="modal-field">
            <div class="modal-label-row">
              <label for="p-prompt">{$_("krea_verbal_passport", {}, "Словесный паспорт (черты лица, прическа, особенности):")}</label>
              {#if personaFormAvatarPreview}
                <button
                  type="button"
                  class="vision-inline-link"
                  disabled={isAnalyzingFace}
                  on:click={() => analyzeFaceForPassport(personaFormAvatarData || personaFormAvatarPreview)}
                >
                  {#if isAnalyzingFace}
                    ⏳ {$_("krea_analyzing_face", {}, "Анализируем лицо...")}
                  {:else}
                    🔍 {$_("krea_autofill_photo", {}, "Заполнить по фото")}
                  {/if}
                </button>
              {/if}
            </div>
            <textarea
              id="p-prompt"
              rows="4"
              placeholder={$_("krea_persona_prompt_placeholder", {}, "детальное словесное описание внешности для фиксации лица во всех генерациях...")}
              bind:value={personaFormPrompt}
              class="modal-textarea"
            ></textarea>
            <span class="field-hint">{$_("krea_passport_hint", {}, "Krea 2 фиксирует лицо строго по этому паспорту. Фотография лица анализируется Vision-нейросетью для извлечения черт лица.")}</span>
          </div>

          <div class="modal-field">
            <label for="p-avatar">{$_("krea_avatar_face_ref", {}, "Аватар / Референс лица:")}</label>
            <div class="avatar-generator-card">
              <div class="avatar-preview-container">
                {#if isGeneratingAvatar}
                  <div class="avatar-loading-box">
                    <span class="avatar-spinner">⏳</span>
                    <span>Krea 2...</span>
                  </div>
                {:else if personaFormAvatarPreview}
                  <img src={personaFormAvatarPreview} alt="Avatar" class="avatar-preview-box" />
                {:else}
                  <div class="avatar-empty-box">👤</div>
                {/if}
              </div>

              <div class="avatar-actions-col">
                <div class="avatar-controls-row">
                  <select bind:value={avatarGenArchetype} class="select-styled archetype-select" disabled={isGeneratingAvatar}>
                    <option value="prompt">{$_("krea_from_passport", {}, "По словесному паспорту")}</option>
                    {#each aiArchetypes as arch}
                      <option value={arch.id}>{arch.name}</option>
                    {/each}
                  </select>

                  <button
                    type="button"
                    class="generate-avatar-btn"
                    disabled={isGeneratingAvatar || (!personaFormPrompt.trim() && avatarGenArchetype === "prompt")}
                    on:click={generateAvatarForPersona}
                  >
                    {#if isGeneratingAvatar}
                      🎨 {$_("krea_creating", {}, "Создание...")}
                    {:else}
                      ✨ {$_("krea_generate_btn", {}, "Сгенерировать")}
                    {/if}
                  </button>
                </div>

                <div class="avatar-manual-upload">
                  <span class="upload-hint">{$_("krea_upload_photo_ref", {}, "Или загрузите фото лица (референс):")}</span>
                  <input
                    id="p-avatar"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    on:change={handleAvatarUpload}
                    class="file-input"
                    disabled={isGeneratingAvatar || isAnalyzingFace}
                  />
                  {#if personaFormAvatarPreview}
                    <button
                      type="button"
                      class="vision-analyze-btn"
                      disabled={isAnalyzingFace}
                      on:click={() => analyzeFaceForPassport(personaFormAvatarData || personaFormAvatarPreview)}
                    >
                      {#if isAnalyzingFace}
                        ⏳ {$_("krea_analyzing_face", {}, "Распознавание лица через Vision...")}
                      {:else}
                        ✨ {$_("krea_recognize_features", {}, "Распознать черты лица с фото (Vision)")}
                      {/if}
                    </button>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="cancel-btn" on:click={() => (showPersonaModal = false)}>{$_("krea_cancel", {}, "Отмена")}</button>
          <button
            class="save-btn"
            disabled={isSavingPersona || !personaFormName.trim() || !personaFormPrompt.trim()}
            on:click={savePersona}
          >
            {isSavingPersona ? $_("krea_saving", {}, "Сохранение...") : $_("krea_save", {}, "Сохранить")}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Modal: AI Persona Factory (Scenario A + B combined) -->
  {#if showAiFactoryModal}
    <div class="modal-backdrop" on:click={() => (showAiFactoryModal = false)}>
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="persona-modal-card ai-factory-modal" on:click|stopPropagation>
        <div class="modal-header">
          <div class="ai-factory-title">
            <span class="ai-icon">✨</span>
            <h3>{$_("krea_factory_title", {}, "AI Фабрика персон")}</h3>
          </div>
          <button class="modal-close-btn" on:click={() => (showAiFactoryModal = false)}>✕</button>
        </div>

        <div class="modal-body">
          <div class="modal-field">
            <label>{$_("krea_select_archetype", {}, "Выберите типаж / архетип:")}</label>
            <div class="archetype-grid">
              {#each aiArchetypes as arch}
                <button
                  class="archetype-card"
                  class:active={aiFactoryArchetype === arch.id}
                  on:click={() => (aiFactoryArchetype = arch.id)}
                >
                  <span class="arch-name">{arch.name}</span>
                  <span class="arch-hint">{arch.hint}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="ai-factory-action-row">
            <button
              class="generate-ai-persona-btn"
              class:busy={isGeneratingAiPersona}
              disabled={isGeneratingAiPersona}
              on:click={generateAiPersona}
            >
              {#if isGeneratingAiPersona}
                <div class="spinner"></div>
                <span>{$_("krea_generating_face", {}, "Генерирую внешность (~4s)...")}</span>
              {:else}
                <span>🎲 {$_("krea_factory_generate_btn", {}, "Сгенерировать паспорт и портрет")}</span>
              {/if}
            </button>
          </div>

          <!-- Generated Persona Preview -->
          {#if generatedAiPersona}
            <div class="generated-persona-card" in:fade={{ duration: 150 }}>
              <div class="gen-avatar-col">
                {#if generatedAiPersona.avatar}
                  <img src={generatedAiPersona.avatar} alt="Avatar" class="gen-avatar-img" />
                {:else}
                  <div class="gen-avatar-empty">👤</div>
                {/if}
              </div>
              <div class="gen-info-col">
                <div class="gen-field">
                  <span class="gen-label">{$_("krea_name_label", {}, "Имя:")}</span>
                  <input type="text" bind:value={generatedAiPersona.name} class="modal-input small" />
                </div>
                <div class="gen-field">
                  <span class="gen-label">{$_("krea_role_label", {}, "Роль:")}</span>
                  <input type="text" bind:value={generatedAiPersona.title} class="modal-input small" />
                </div>
                <div class="gen-field">
                  <span class="gen-label">{$_("krea_verbal_passport", {}, "Словесный паспорт:")}</span>
                  <textarea rows="3" bind:value={generatedAiPersona.prompt} class="modal-textarea small"></textarea>
                </div>
              </div>
            </div>
          {/if}
        </div>

        <div class="modal-footer">
          <button class="cancel-btn" on:click={() => (showAiFactoryModal = false)}>{$_("krea_close", {}, "Закрыть")}</button>
          {#if generatedAiPersona}
            <button class="save-btn" on:click={saveAiGeneratedPersona}>
              💾 {$_("krea_save_to_personas", {}, "Сохранить в мои персоны")}
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- Delete Confirmation Modal (Native OMD Style) -->
  {#if deleteConfirmTarget}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="confirm-modal-overlay"
      transition:fade={{ duration: 150 }}
      on:click|self={() => (deleteConfirmTarget = null)}
    >
      <div class="confirm-modal-box" transition:fly={{ y: 20, duration: 200 }}>
        <div class="confirm-modal-header">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#f85149" stroke-width="2" class="confirm-danger-icon">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <h3>{deleteConfirmTarget.title}</h3>
        </div>
        <div class="confirm-modal-body">
          <p>
            {$_("krea_delete_confirm_text", { name: deleteConfirmTarget.name }, `Вы уверены, что хотите удалить «${deleteConfirmTarget.name}»?`)}
          </p>
          {#if deleteConfirmTarget.subtext}
            <p class="confirm-modal-subtext">{deleteConfirmTarget.subtext}</p>
          {/if}
        </div>
        <div class="confirm-modal-actions">
          <button
            class="confirm-btn cancel"
            on:click={() => (deleteConfirmTarget = null)}
            disabled={isDeletingItem}
          >
            {$_("cancel", {}, "Отмена")}
          </button>
          <button
            class="confirm-btn danger"
            on:click={executeConfirmDelete}
            disabled={isDeletingItem}
          >
            {isDeletingItem ? $_("krea_deleting", {}, "Удаление...") : $_("delete", {}, "Удалить")}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .krea-studio-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: #0d1117;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    position: relative;
    overflow: hidden;
  }

  /* Header */
  .studio-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 18px;
    background: rgba(18, 22, 30, 0.95);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(12px);
    z-index: 20;
    gap: 12px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .sidebar-toggle-btn {
    background: transparent;
    border: none;
    color: #8b949e;
    cursor: pointer;
    padding: 6px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .sidebar-toggle-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
  }

  .header-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .studio-badge {
    font-size: 16px;
    font-weight: 700;
    background: linear-gradient(135deg, #a78bfa 0%, #ec4899 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .turbo-pill {
    font-size: 11px;
    font-weight: 600;
    background: rgba(167, 139, 250, 0.15);
    color: #c4b5fd;
    border: 1px solid rgba(167, 139, 250, 0.3);
    padding: 2px 7px;
    border-radius: 10px;
  }

  .header-subtitle {
    font-size: 11px;
    color: #8b949e;
    margin-top: 1px;
  }

  /* Header Tabs */
  .header-tabs {
    display: flex;
    align-items: center;
    background: rgba(255, 255, 255, 0.05);
    padding: 3px;
    border-radius: 20px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    gap: 4px;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 16px;
    background: transparent;
    border: none;
    color: #8b949e;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .tab-btn:hover {
    color: #fff;
  }

  .tab-btn.active {
    background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
    color: #ffffff;
    box-shadow: 0 2px 10px rgba(124, 58, 237, 0.35);
  }

  .tab-btn .badge {
    font-size: 10px;
    background: rgba(0, 0, 0, 0.3);
    padding: 1px 6px;
    border-radius: 8px;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .icon-btn {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #8b949e;
    border-radius: 8px;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
  }

  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
  }

  .sort-order-btn {
    position: relative;
  }

  .sort-order-btn:hover {
    color: var(--accent-blue, #38bdf8);
  }

  .sort-order-btn.is-active {
    color: var(--accent-blue, #38bdf8);
    background: rgba(56, 189, 248, 0.12);
    border-color: rgba(56, 189, 248, 0.3);
  }

  .icon-btn.spinning svg {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    100% { transform: rotate(360deg); }
  }

  /* Main Area */
  .studio-main {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px 220px 24px;
  }

  /* Personas View */
  .personas-section {
    max-width: 1200px;
    margin: 0 auto;
  }

  .section-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
    gap: 16px;
  }

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .section-desc h3 {
    margin: 0 0 4px 0;
    font-size: 18px;
    font-weight: 600;
  }

  .section-desc p {
    margin: 0;
    font-size: 13px;
    color: #8b949e;
  }

  .ai-factory-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 8px;
    background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);
    color: #fff;
    border: none;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(236, 72, 153, 0.35);
    transition: all 0.2s;
  }

  .ai-factory-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 18px rgba(236, 72, 153, 0.5);
  }

  .create-persona-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-radius: 8px;
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    color: #fff;
    border: none;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    transition: all 0.2s;
  }

  .create-persona-btn:hover {
    opacity: 0.95;
    transform: translateY(-1px);
  }

  .personas-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 18px;
  }

  .persona-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    position: relative;
  }

  .persona-card:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(167, 139, 250, 0.3);
    transform: translateY(-2px);
  }

  .persona-card.selected {
    border-color: #8b5cf6;
    background: rgba(139, 92, 246, 0.08);
    box-shadow: 0 0 20px rgba(139, 92, 246, 0.25);
  }

  .persona-avatar-wrap {
    position: relative;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.08);
  }

  .persona-avatar {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .persona-avatar-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 20px;
    color: #c4b5fd;
    background: linear-gradient(135deg, #312e81 0%, #4c1d95 100%);
  }

  .active-check-badge {
    position: absolute;
    bottom: 0;
    right: 0;
    background: #10b981;
    color: #fff;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: bold;
    border: 2px solid #0d1117;
  }

  .persona-header-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .persona-name {
    font-weight: 700;
    font-size: 16px;
  }

  .persona-title-chip {
    font-size: 11px;
    color: #a78bfa;
    background: rgba(167, 139, 250, 0.12);
    padding: 2px 6px;
    border-radius: 6px;
  }

  .persona-ref-chip {
    font-size: 10px;
    font-weight: 700;
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.15);
    border: 1px solid rgba(56, 189, 248, 0.35);
    padding: 2px 6px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  .persona-passport {
    font-size: 12px;
    color: #94a3b8;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0;
  }

  .persona-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: auto;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .card-action-btn {
    border: none;
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    background: rgba(255, 255, 255, 0.08);
    color: #e2e8f0;
    transition: all 0.15s;
  }

  .card-action-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .card-action-btn.select-btn.active {
    background: #8b5cf6;
    color: #fff;
  }

  .card-action-btn.icon-only {
    padding: 5px 8px;
  }

  .card-action-btn.danger:hover {
    background: rgba(239, 68, 68, 0.2);
    color: #f87171;
  }

  .add-new-slot {
    align-items: center;
    justify-content: center;
    border: 2px dashed rgba(255, 255, 255, 0.12);
    background: transparent;
    min-height: 180px;
  }

  .add-slot-circle {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.06);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    color: #a78bfa;
    margin-bottom: 6px;
  }

  .add-slot-label {
    font-size: 14px;
    font-weight: 600;
    color: #e2e8f0;
  }

  .add-slot-hint {
    font-size: 11px;
    color: #64748b;
  }

  /* Gallery View */
  .gallery-section {
    max-width: 1400px;
    margin: 0 auto;
  }

  .empty-gallery {
    text-align: center;
    padding: 60px 20px;
    max-width: 600px;
    margin: 0 auto;
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 12px;
  }

  .empty-gallery h3 {
    margin: 0 0 8px 0;
    font-size: 20px;
  }

  .empty-gallery p {
    color: #8b949e;
    font-size: 14px;
    margin-bottom: 24px;
  }

  .empty-suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }

  .sug-pill {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #c4b5fd;
    padding: 6px 12px;
    border-radius: 16px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .sug-pill:hover {
    background: rgba(167, 139, 250, 0.15);
    border-color: rgba(167, 139, 250, 0.4);
  }

  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
  }

  .gallery-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: all 0.2s;
  }

  /* Dynamic Generating Placeholder Card */
  .placeholder-card {
    position: relative;
    border: 1px solid rgba(139, 92, 246, 0.45);
    box-shadow: 0 0 25px rgba(139, 92, 246, 0.2);
    animation: placeholderBorderGlow 3s ease-in-out infinite alternate;
  }

  @keyframes placeholderBorderGlow {
    0% {
      border-color: rgba(139, 92, 246, 0.35);
      box-shadow: 0 0 15px rgba(139, 92, 246, 0.15);
    }
    100% {
      border-color: rgba(236, 72, 153, 0.65);
      box-shadow: 0 0 30px rgba(236, 72, 153, 0.3);
    }
  }

  .placeholder-preview {
    position: relative;
    aspect-ratio: 3 / 4;
    overflow: hidden;
    background: radial-gradient(circle at 50% 40%, #1a102f 0%, #0c0d14 70%, #06070a 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    box-sizing: border-box;
  }

  .shimmer-mesh {
    position: absolute;
    inset: -60%;
    background: radial-gradient(circle at 50% 50%, rgba(139, 92, 246, 0.25), transparent 55%),
                radial-gradient(circle at 80% 20%, rgba(236, 72, 153, 0.2), transparent 45%),
                radial-gradient(circle at 20% 80%, rgba(59, 130, 246, 0.2), transparent 45%);
    animation: rotateMesh 10s linear infinite;
  }

  @keyframes rotateMesh {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .glow-orb {
    position: absolute;
    width: 140px;
    height: 140px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(168, 85, 247, 0.35) 0%, rgba(168, 85, 247, 0) 70%);
    filter: blur(20px);
    animation: floatOrb 4s ease-in-out infinite alternate;
  }

  @keyframes floatOrb {
    0% { transform: translate(-20px, -15px) scale(0.9); }
    100% { transform: translate(20px, 15px) scale(1.15); }
  }

  .placeholder-content {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 12px;
    width: 100%;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 9999px;
    background: rgba(10, 11, 20, 0.75);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    font-size: 12px;
    font-weight: 600;
    color: #f8fafc;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 10px #10b981;
    animation: pulseDotAnim 1.2s ease-in-out infinite;
  }

  @keyframes pulseDotAnim {
    0%, 100% { transform: scale(0.85); opacity: 0.6; }
    50% { transform: scale(1.35); opacity: 1; }
  }

  .placeholder-prompt {
    font-size: 13px;
    line-height: 1.45;
    color: rgba(255, 255, 255, 0.9);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    margin: 0;
    font-weight: 500;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
    max-width: 90%;
  }

  .placeholder-progress-bar {
    width: 75%;
    height: 4px;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 9999px;
    overflow: hidden;
    position: relative;
  }

  .progress-bar-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 35%;
    border-radius: 9999px;
    background: linear-gradient(90deg, #8b5cf6, #ec4899);
    animation: indeterminateProgress 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }

  .progress-bar-fill.downloading {
    background: linear-gradient(90deg, #3b82f6, #10b981);
    animation: indeterminateProgress 0.9s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }

  @keyframes indeterminateProgress {
    0% { left: -35%; width: 35%; }
    50% { left: 40%; width: 45%; }
    100% { left: 100%; width: 35%; }
  }

  .placeholder-footer {
    opacity: 0.85;
  }

  .krea-studio-root.light-theme .placeholder-preview {
    background: radial-gradient(circle at 50% 40%, #ede9fe 0%, #e2e8f0 70%, #f1f5f9 100%);
  }

  .krea-studio-root.light-theme .status-pill {
    background: rgba(255, 255, 255, 0.9);
    color: #0f172a;
    border-color: rgba(0, 0, 0, 0.12);
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.08);
  }

  .krea-studio-root.light-theme .placeholder-prompt {
    color: #1e293b;
    text-shadow: none;
  }

  .gallery-card:hover {
    border-color: rgba(255, 255, 255, 0.2);
    transform: translateY(-2px);
  }

  .gallery-card-thumb-wrap {
    display: block;
    aspect-ratio: 3 / 4;
    overflow: hidden;
    background: #05070a;
    cursor: pointer;
    position: relative;
  }

  .gallery-thumb {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.3s ease;
  }

  .gallery-thumb[src=""] {
    opacity: 0;
  }

  .gallery-card:hover .gallery-thumb {
    transform: scale(1.03);
  }

  .card-footer-info {
    padding: 8px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    gap: 6px;
    min-height: 40px;
  }

  .card-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
    overflow: hidden;
  }

  .card-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #cbd5e1;
    font-weight: 500;
    font-size: 11.5px;
  }

  .persona-tag {
    font-size: 10px;
    background: rgba(139, 92, 246, 0.2);
    color: #c4b5fd;
    padding: 2px 6px;
    border-radius: 6px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .card-time-tag {
    font-size: 10px;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.75);
    padding: 2px 6px;
    border-radius: 6px;
    white-space: nowrap;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .card-time-tag .gpu-sub {
    color: #a78bfa;
    font-size: 9.5px;
    font-weight: 600;
  }

  .card-toolbar {
    display: flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
  }

  .card-toolbar .toolbar-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    width: 24px;
    height: 24px;
    border-radius: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.15s ease;
    padding: 0;
    font-size: 11px;
    opacity: 0.65;
  }

  .gallery-card:hover .card-toolbar .toolbar-btn {
    opacity: 0.9;
  }

  .card-toolbar .toolbar-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #ffffff;
    opacity: 1;
  }

  .card-toolbar .toolbar-btn.copied {
    color: #10b981;
    opacity: 1;
  }

  .card-toolbar .card-delete-btn:hover {
    color: #f87171;
    background: rgba(239, 68, 68, 0.15);
  }

  /* Sticky Composer */
  .studio-composer {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: rgba(15, 20, 28, 0.96);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(16px);
    padding: 14px 20px;
    z-index: 30;
    box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.5);
  }

  .composer-controls-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    gap: 6px;
    width: 100%;
    box-sizing: border-box;
  }

  .active-persona-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(139, 92, 246, 0.18);
    border: 1px solid rgba(139, 92, 246, 0.4);
    padding: 0 10px;
    border-radius: 12px;
    height: 26px;
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    box-sizing: border-box;
    white-space: nowrap;
  }

  .pill-name {
    font-weight: 500;
    font-size: 11px;
    font-family: inherit;
    color: #e9d5ff;
  }

  .pill-hint {
    color: #a78bfa;
    font-size: 11px;
    font-weight: 500;
  }

  .pill-clear-btn {
    background: transparent;
    border: none;
    color: #c4b5fd;
    cursor: pointer;
    font-size: 11px;
    padding: 0 2px;
  }

  .pick-persona-btn {
    background: transparent;
    border: 1px solid rgba(167, 139, 250, 0.3);
    color: #c4b5fd;
    padding: 0 9px;
    height: 26px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    box-sizing: border-box;
    white-space: nowrap;
    transition: all 0.15s ease;
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pick-persona-btn:hover {
    background: rgba(139, 92, 246, 0.15);
    border-color: rgba(167, 139, 250, 0.5);
    color: #ede9fe;
  }

  .composer-controls-right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-left: auto;
    gap: 4px;
    flex-shrink: 0;
  }

  .toggle-tokens-btn,
  .toggle-sliders-btn {
    background: transparent;
    border: 1px solid rgba(167, 139, 250, 0.3);
    color: #c4b5fd;
    padding: 0 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    box-sizing: border-box;
    white-space: nowrap;
    transition: all 0.15s ease;
  }

  .toggle-tokens-btn:hover,
  .toggle-sliders-btn:hover {
    background: rgba(139, 92, 246, 0.15);
    border-color: rgba(167, 139, 250, 0.5);
    color: #ede9fe;
  }

  .toggle-tokens-btn.open,
  .toggle-tokens-btn.active,
  .toggle-sliders-btn.open {
    color: #c4b5fd;
    border-color: rgba(167, 139, 250, 0.3);
    background: rgba(139, 92, 246, 0.15);
  }

  .pill-chevron {
    font-size: 10px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 2px;
    color: currentColor;
    font-weight: 600;
  }

  /* Sliders Panel & Param Cards */
  .sliders-panel {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 12px;
    padding: 12px 14px;
    background: rgba(0, 0, 0, 0.35);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    margin-bottom: 12px;
  }

  .param-card {
    display: flex;
    flex-direction: column;
    justify-content: center;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    padding: 10px 12px;
    min-height: 56px;
    min-width: 0;
    box-sizing: border-box;
  }

  .param-card.aspect-settings-card {
    justify-content: flex-start;
  }

  .card-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    margin-bottom: 6px;
    min-height: 18px;
  }

  .card-header-row .select-label {
    margin: 0;
    line-height: 1;
    font-size: 11px;
    color: #94a3b8;
  }

  .advanced-settings-control {
    position: relative;
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center;
    min-width: 0 !important;
    width: auto !important;
    flex-shrink: 0;
    margin: 0 !important;
    padding: 0 !important;
    gap: 0 !important;
  }

  .composer-controls-right :global(.dropdown-control) {
    min-width: 0 !important;
    width: auto !important;
    display: inline-flex !important;
    flex-direction: row !important;
    gap: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
  }

  .advanced-gear-btn {
    height: 26px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 9px;
    background: transparent;
    border: 1px solid rgba(167, 139, 250, 0.3);
    border-radius: 12px;
    color: #c4b5fd;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
    max-width: 100%;
    box-sizing: border-box;
  }

  .advanced-gear-btn svg {
    color: #a78bfa;
    flex-shrink: 0;
    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .advanced-gear-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(167, 139, 250, 0.3);
    color: #f1f5f9;
  }

  .advanced-gear-btn:hover svg {
    transform: rotate(45deg);
  }

  .advanced-gear-btn.active {
    background: rgba(139, 92, 246, 0.15);
    border-color: #8b5cf6;
    color: #ede9fe;
    box-shadow: 0 0 10px rgba(139, 92, 246, 0.25);
  }

  .advanced-gear-btn.active svg {
    transform: rotate(90deg);
    color: #c4b5fd;
  }

  .gear-summary-text {
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
  }


  .dropdown-popup-menu.advanced-popup {
    left: auto !important;
    right: 0 !important;
    bottom: calc(100% + 8px);
    width: 320px;
    max-width: calc(100vw - 32px);
    padding: 10px 0 6px 0;
    box-sizing: border-box;
  }

  .advanced-popup-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 8px 14px 10px;
  }

  .advanced-setting-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .setting-title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
  }

  .setting-name {
    font-weight: 500;
    color: #e2e8f0;
  }

  .setting-val-badge {
    font-size: 11px;
    font-weight: 700;
    color: #c4b5fd;
    background: rgba(139, 92, 246, 0.2);
    border: 1px solid rgba(139, 92, 246, 0.3);
    padding: 1px 7px;
    border-radius: 6px;
    font-variant-numeric: tabular-nums;
  }

  .advanced-slider {
    width: 100%;
    height: 5px;
    margin: 2px 0 0;
    accent-color: #8b5cf6;
    cursor: pointer;
  }

  .setting-subtext {
    display: flex;
    justify-content: space-between;
    font-size: 9px;
    color: #64748b;
    line-height: 1;
    margin-top: 2px;
  }

  .slider-control {
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: opacity 0.2s ease;
  }

  .slider-control.disabled {
    opacity: 0.35;
    pointer-events: none;
  }

  .slider-header {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: #94a3b8;
  }

  .slider-val {
    font-weight: 600;
    color: #c4b5fd;
  }

  .slider-input {
    width: 100%;
    accent-color: #8b5cf6;
    height: 4px;
    cursor: pointer;
  }

  .slider-ticks {
    display: flex;
    justify-content: space-between;
    font-size: 9px;
    color: #64748b;
  }

  /* Model Pill Toggle Control */
  .model-pill-control {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    min-width: 0;
  }

  .model-pill-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    color: #94a3b8;
    min-height: 18px;
    margin-bottom: 2px;
  }

  .model-pill-hint {
    font-size: 10px;
    font-weight: 600;
    color: #a78bfa;
    background: rgba(167, 139, 250, 0.12);
    padding: 1px 6px;
    border-radius: 6px;
    white-space: nowrap;
  }

  .pill-toggle-wrapper {
    display: flex;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 2px;
    gap: 2px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }

  .pill-btn {
    flex: 1 1 0;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 5px 3px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: #94a3b8;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    box-sizing: border-box;
    overflow: hidden;
  }

  .pill-btn span:not(.pill-icon) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .pill-btn:hover {
    color: #e2e8f0;
    background: rgba(255, 255, 255, 0.05);
  }

  .pill-btn.active {
    background: linear-gradient(135deg, #7c3aed, #6366f1);
    color: #ffffff;
    font-weight: 600;
    box-shadow: 0 2px 6px rgba(124, 58, 237, 0.35);
  }

  .pill-icon {
    font-size: 12px;
    line-height: 1;
    flex-shrink: 0;
  }

  .select-control {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .select-label {
    font-size: 11px;
    color: #94a3b8;
  }

  /* Dropdown Controls */
  .dropdown-control {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 135px;
  }

  .dropdown-trigger-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #cbd5e1;
    font-size: 12px;
    font-weight: 500;
    padding: 6px 10px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
    height: 32px;
    width: 100%;
    box-sizing: border-box;
  }

  .dropdown-trigger-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #ffffff;
    border-color: rgba(255, 255, 255, 0.2);
  }

  .dropdown-trigger-btn.active {
    background: rgba(139, 92, 246, 0.2);
    border-color: #8b5cf6;
    color: #f3e8ff;
    box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.25);
  }

  .dropdown-trigger-btn.has-style {
    background: rgba(139, 92, 246, 0.15);
    border-color: rgba(139, 92, 246, 0.45);
    color: #f3e8ff;
    font-weight: 600;
  }

  .dropdown-trigger-btn.has-style.active {
    border-color: #8b5cf6;
    box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.25);
  }

  .dropdown-trigger-btn.has-archetype {
    background: rgba(236, 72, 153, 0.15);
    border-color: rgba(236, 72, 153, 0.5);
    color: #fdf2f8;
    font-weight: 600;
  }

  .dropdown-trigger-btn.has-archetype.active {
    border-color: #ec4899;
    box-shadow: 0 0 0 2px rgba(236, 72, 153, 0.25);
  }

  .trigger-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
  }

  .chevron {
    flex-shrink: 0;
    color: #94a3b8;
    transition: transform 0.2s ease;
  }

  .chevron.open {
    transform: rotate(180deg);
    color: inherit;
  }

  /* Floating Dropdown Popup Menu */
  .dropdown-popup-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    width: 300px;
    max-width: calc(100vw - 32px);
    background: #1e232d;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(20px);
    z-index: 100;
    overflow: hidden;
    padding: 6px 0;
  }

  .archetype-popup {
    left: auto;
    right: 0;
  }

  @media (max-width: 600px) {
    .dropdown-popup-menu {
      left: 0;
      right: auto;
      width: calc(100vw - 40px);
    }
  }

  .popup-menu-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #8b949e;
    margin-bottom: 4px;
  }

  .popup-reset-link {
    background: transparent;
    border: none;
    color: #f472b6;
    font-size: 10px;
    cursor: pointer;
    padding: 0;
    text-transform: none;
    font-weight: 500;
  }

  .popup-reset-link:hover {
    text-decoration: underline;
  }

  .popup-options-list {
    max-height: 350px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 4px;
  }

  .popup-option-card {
    display: flex;
    flex-direction: column;
    border-radius: 8px;
    background: transparent;
    transition: background 0.12s ease;
    border: 1px solid transparent;
  }

  .popup-option-card:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .popup-option-card.selected {
    background: rgba(139, 92, 246, 0.18);
    border-color: rgba(139, 92, 246, 0.35);
  }

  .archetype-popup .popup-option-card.selected {
    background: rgba(236, 72, 153, 0.18);
    border-color: rgba(236, 72, 153, 0.35);
  }

  .popup-option-row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    padding: 8px 10px 4px;
    background: transparent;
    border: none;
    color: #e6edf3;
    cursor: pointer;
    text-align: left;
    width: 100%;
    box-sizing: border-box;
  }

  .option-inline-slider-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2px 12px 10px 34px;
    box-sizing: border-box;
    min-height: 26px;
  }

  .inline-weight-slider {
    flex: 1;
    height: 6px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    outline: none;
    cursor: pointer;
    accent-color: #8b5cf6;
    margin: 0;
  }

  .inline-weight-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #8b5cf6;
    border: 2px solid #ffffff;
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }

  .inline-weight-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #8b5cf6;
    border: 2px solid #ffffff;
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }

  .archetype-popup .inline-weight-slider {
    accent-color: #ec4899;
  }

  .archetype-popup .inline-weight-slider::-webkit-slider-thumb {
    background: #ec4899;
  }

  .archetype-popup .inline-weight-slider::-moz-range-thumb {
    background: #ec4899;
  }

  .inline-weight-val {
    font-size: 12px;
    font-weight: 700;
    color: #c4b5fd;
    min-width: 32px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .archetype-popup .inline-weight-val {
    color: #f472b6;
  }

  .popup-option-item {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 8px;
    background: transparent;
    border: none;
    color: #e6edf3;
    cursor: pointer;
    text-align: left;
    transition: background 0.12s ease;
    width: 100%;
    box-sizing: border-box;
  }

  .popup-option-item:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .popup-option-item.selected {
    background: rgba(139, 92, 246, 0.18);
    color: #f3e8ff;
  }

  .archetype-popup .popup-option-item.selected {
    background: rgba(236, 72, 153, 0.18);
    color: #fdf2f8;
  }

  .option-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    text-align: left;
  }

  .option-label {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
  }

  .option-desc {
    font-size: 10px;
    color: #94a3b8;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .popup-option-item.selected .option-desc {
    color: #cbd5e1;
  }

  .option-check {
    font-size: 13px;
    font-weight: 700;
    color: #a78bfa;
    flex-shrink: 0;
    margin-left: auto;
  }

  .active-personas-wrap {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .add-more-personas-btn {
    background: rgba(255, 255, 255, 0.05);
    border: 1px dashed rgba(255, 255, 255, 0.2);
    color: #94a3b8;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .add-more-personas-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }

  .go-gallery-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(139, 92, 246, 0.2);
    border: 1.5px solid #8b5cf6;
    color: #f3e8ff;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(139, 92, 246, 0.25);
    transition: all 0.2s;
  }

  .go-gallery-btn:hover {
    background: #8b5cf6;
    color: #ffffff;
    box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);
    transform: translateY(-1px);
  }

  .option-check-icon {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    border: 1.5px solid rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.04);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-sizing: border-box;
    transition: all 0.15s ease;
    color: #ffffff;
  }

  .option-check-icon.radio {
    border-radius: 50%;
  }

  .option-check-icon.checked {
    background: #ec4899;
    border-color: #ec4899;
    color: #ffffff;
    box-shadow: 0 0 8px rgba(236, 72, 153, 0.35);
  }

  .option-check-icon .check-svg {
    display: block;
  }

  .popup-menu-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    margin-top: 4px;
    background: rgba(0, 0, 0, 0.2);
  }

  .popup-count-hint {
    font-size: 11px;
    color: #94a3b8;
  }

  .popup-done-btn {
    background: #8b5cf6;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 12px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .popup-done-btn:hover {
    background: #7c3aed;
  }

  .aspect-chips {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    width: 100%;
    box-sizing: border-box;
  }

  .aspect-chip {
    flex: 1 1 0;
    min-width: 0;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #cbd5e1;
    font-size: 11px;
    padding: 0 4px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .aspect-chip.active {
    background: rgba(139, 92, 246, 0.25);
    border-color: #8b5cf6;
    color: #f3e8ff;
    font-weight: 600;
  }

  /* Active Modifiers Bar */
  .active-modifiers-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    padding: 0 2px;
  }

  .active-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 500;
    padding: 3px 8px;
    border-radius: 12px;
    line-height: 1.2;
    transition: all 0.2s ease;
  }

  .persona-pill {
    background: rgba(139, 92, 246, 0.2);
    border: 1px solid rgba(139, 92, 246, 0.4);
    color: #ddd6fe;
  }

  .style-pill {
    background: rgba(59, 130, 246, 0.2);
    border: 1px solid rgba(59, 130, 246, 0.35);
    color: #bfdbfe;
  }

  .archetype-pill {
    background: rgba(236, 72, 153, 0.2);
    border: 1px solid rgba(236, 72, 153, 0.4);
    color: #fbcfe8;
  }

  .pill-remove-btn {
    background: transparent;
    border: none;
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    font-size: 10px;
    padding: 0 2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .pill-remove-btn:hover {
    opacity: 1;
  }


  /* Tokens Preview Panel */
  .tokens-preview-panel {
    background: rgba(15, 23, 42, 0.95);
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 8px;
    font-size: 11px;
    line-height: 1.5;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }

  .tokens-preview-header {
    margin-bottom: 6px;
  }

  .preview-title {
    font-weight: 600;
    color: #c4b5fd;
    font-size: 11px;
    letter-spacing: 0.2px;
  }

  .tokens-preview-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .token-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    word-break: break-word;
  }

  .token-badge {
    display: inline-block;
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 6px;
  }

  .token-badge-persona {
    background: rgba(139, 92, 246, 0.25);
    color: #c4b5fd;
  }

  .token-badge-ref {
    background: rgba(56, 189, 248, 0.25);
    color: #7dd3fc;
    border: 1px solid rgba(56, 189, 248, 0.4);
  }

  .token-badge-style {
    background: rgba(59, 130, 246, 0.25);
    color: #93c5fd;
  }

  .token-badge-archetype {
    background: rgba(236, 72, 153, 0.25);
    color: #f472b6;
  }

  .token-badge-user {
    background: rgba(34, 197, 94, 0.25);
    color: #86efac;
  }

  .token-text {
    color: #cbd5e1;
    font-size: 11px;
  }

  /* Composer Input */
  .composer-input-row {
    display: flex;
    gap: 12px;
    align-items: flex-end;
  }

  .prompt-textarea {
    flex: 1;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    color: #fff;
    padding: 9px 14px;
    font-size: 14px;
    font-family: inherit;
    resize: none;
    line-height: 20px;
    height: 40px;
    min-height: 40px;
    max-height: 125px;
    box-sizing: border-box;
    outline: none;
    overflow-y: hidden;
    transition: border-color 0.2s;
  }

  .prompt-textarea:focus {
    border-color: #8b5cf6;
  }

  .composer-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  /* Prompts History Button */
  .prompts-history-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #94a3b8;
    width: 42px;
    height: 42px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .prompts-history-btn:hover,
  .prompts-history-btn.active {
    background: rgba(139, 92, 246, 0.2);
    border-color: #8b5cf6;
    color: #c084fc;
  }

  /* Prompts Popup */
  .prompts-popup {
    position: absolute;
    bottom: calc(100% + 10px);
    left: 20px;
    right: 20px;
    max-width: 820px;
    margin: 0 auto;
    background: #1e293b;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 16px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(24px);
    z-index: 60;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: popIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes popIn {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .prompts-popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .prompts-header-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    color: #ffffff;
  }

  .prompts-popup-close {
    background: transparent;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    transition: color 0.15s ease;
  }

  .prompts-popup-close:hover {
    color: #ffffff;
  }

  .prompts-search-wrap {
    padding: 8px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .prompts-search-input {
    width: 100%;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 0.82rem;
    color: #ffffff;
    outline: none;
    box-sizing: border-box;
  }

  .prompts-search-input:focus {
    border-color: #8b5cf6;
  }

  .prompts-popup-list {
    max-height: 280px;
    overflow-y: auto;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .prompt-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .prompt-item:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .prompt-item-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .prompt-item-text {
    font-size: 0.86rem;
    color: #ffffff;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .prompt-item-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.72rem;
    color: #94a3b8;
  }

  .prompt-style-badge {
    background: rgba(139, 92, 246, 0.2);
    color: #c084fc;
    padding: 1px 6px;
    border-radius: 4px;
    font-weight: 500;
    text-transform: capitalize;
  }

  .prompt-time {
    font-size: 0.72rem;
    color: #94a3b8;
  }

  .prompt-delete-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    padding: 6px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: all 0.15s ease;
  }

  .prompt-item:hover .prompt-delete-btn {
    opacity: 1;
  }

  .prompt-delete-btn:hover {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.15);
  }

  .prompts-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 32px 16px;
    color: #94a3b8;
    font-size: 0.85rem;
  }

  .random-idea-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #fff;
    width: 42px;
    height: 42px;
    border-radius: 10px;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
  }

  .random-idea-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .random-idea-btn .dice-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    transform-origin: center center;
    will-change: transform;
    pointer-events: none;
  }

  .random-idea-btn.spinning {
    opacity: 0.85;
    cursor: wait;
  }

  .random-idea-btn.spinning .dice-icon {
    animation: diceSpin 0.7s linear infinite;
  }

  @keyframes diceSpin {
    0% { transform: rotate(0deg) scale(0.92); }
    50% { transform: rotate(180deg) scale(1.18); }
    100% { transform: rotate(360deg) scale(0.92); }
  }

  .generate-submit-btn {
    height: 42px;
    padding: 0 20px;
    border-radius: 10px;
    background: linear-gradient(135deg, #7c3aed 0%, #ec4899 100%);
    border: none;
    color: #fff;
    font-weight: 600;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(124, 58, 237, 0.4);
    transition: all 0.2s;
  }

  .generate-submit-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 6px 20px rgba(124, 58, 237, 0.5);
  }

  .generate-submit-btn.busy {
    background: #374151;
    cursor: not-allowed;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(8px);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .persona-modal-card {
    background: #161b22;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 16px;
    width: 100%;
    max-width: 540px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .modal-header h3 {
    margin: 0;
    font-size: 17px;
  }

  .ai-factory-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ai-icon {
    font-size: 20px;
  }

  .modal-close-btn {
    background: transparent;
    border: none;
    color: #8b949e;
    cursor: pointer;
    font-size: 16px;
  }

  .modal-body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .modal-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .modal-field label {
    font-size: 12px;
    font-weight: 600;
    color: #cbd5e1;
  }

  .modal-input, .modal-textarea {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    color: #fff;
    padding: 8px 12px;
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }

  .modal-input.small, .modal-textarea.small {
    padding: 6px 10px;
    font-size: 12px;
  }

  .modal-textarea {
    resize: vertical;
  }

  .modal-input:focus, .modal-textarea:focus {
    border-color: #8b5cf6;
  }

  .field-hint {
    font-size: 11px;
    color: #64748b;
  }

  .avatar-upload-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .avatar-generator-card {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 12px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
  }

  .avatar-preview-container {
    flex-shrink: 0;
  }

  .avatar-preview-box {
    width: 68px;
    height: 68px;
    border-radius: 12px;
    object-fit: cover;
    border: 1.5px solid rgba(139, 92, 246, 0.5);
    display: block;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .avatar-loading-box {
    width: 68px;
    height: 68px;
    border-radius: 12px;
    background: rgba(139, 92, 246, 0.1);
    border: 1.5px dashed rgba(139, 92, 246, 0.6);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: #c084fc;
    gap: 4px;
  }

  .avatar-spinner {
    font-size: 18px;
    animation: avatarSpin 1.5s linear infinite;
  }

  @keyframes avatarSpin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .avatar-empty-box {
    width: 68px;
    height: 68px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px dashed rgba(255, 255, 255, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    color: #64748b;
  }

  .avatar-actions-col {
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-width: 0;
  }

  .avatar-controls-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .archetype-select {
    flex: 1;
    min-width: 140px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    color: #f1f5f9;
    padding: 7px 10px;
    font-size: 12px;
    outline: none;
    cursor: pointer;
  }

  .archetype-select:focus {
    border-color: #8b5cf6;
  }

  .archetype-select option {
    background: #1e293b;
    color: #fff;
  }

  .generate-avatar-btn {
    background: linear-gradient(135deg, #7c3aed, #6366f1);
    color: #ffffff;
    border: none;
    border-radius: 8px;
    padding: 7px 14px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s ease;
    box-shadow: 0 2px 8px rgba(124, 58, 237, 0.3);
  }

  .generate-avatar-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, #8b5cf6, #4f46e5);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(124, 58, 237, 0.4);
  }

  .generate-avatar-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .avatar-manual-upload {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .upload-hint {
    font-size: 11px;
    color: #94a3b8;
  }

  .modal-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .vision-inline-link {
    background: transparent;
    border: none;
    color: #a78bfa;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
    transition: color 0.15s;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .vision-inline-link:hover:not(:disabled) {
    color: #c084fc;
  }

  .vision-inline-link:disabled {
    opacity: 0.6;
    cursor: wait;
    text-decoration: none;
  }

  .vision-analyze-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(139, 92, 246, 0.15);
    border: 1px solid rgba(139, 92, 246, 0.4);
    color: #c084fc;
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    margin-top: 4px;
    width: fit-content;
  }

  .vision-analyze-btn:hover:not(:disabled) {
    background: rgba(139, 92, 246, 0.28);
    border-color: #a855f7;
    color: #ffffff;
  }

  .vision-analyze-btn:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .file-input {
    font-size: 12px;
    color: #94a3b8;
  }

  /* AI Factory Archetypes */
  .archetype-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }

  .archetype-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
  }

  .archetype-card:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(167, 139, 250, 0.3);
  }

  .archetype-card.active {
    background: rgba(139, 92, 246, 0.15);
    border-color: #8b5cf6;
    box-shadow: 0 0 12px rgba(139, 92, 246, 0.25);
  }

  .arch-name {
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    margin-bottom: 2px;
  }

  .arch-hint {
    font-size: 11px;
    color: #94a3b8;
    line-height: 1.3;
  }

  .ai-factory-action-row {
    margin-top: 4px;
  }

  .generate-ai-persona-btn {
    width: 100%;
    padding: 10px 16px;
    border-radius: 10px;
    background: linear-gradient(135deg, #7c3aed 0%, #ec4899 100%);
    border: none;
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    box-shadow: 0 4px 14px rgba(124, 58, 237, 0.35);
  }

  .generate-ai-persona-btn:hover:not(:disabled) {
    opacity: 0.95;
    transform: translateY(-1px);
  }

  .generated-persona-card {
    display: flex;
    gap: 14px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    margin-top: 6px;
  }

  .gen-avatar-col {
    width: 90px;
    flex-shrink: 0;
  }

  .gen-avatar-img {
    width: 90px;
    height: 115px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  .gen-avatar-empty {
    width: 90px;
    height: 115px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    font-size: 32px;
  }

  .gen-info-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .gen-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .gen-label {
    font-size: 11px;
    color: #94a3b8;
    font-weight: 600;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    background: rgba(0, 0, 0, 0.2);
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .cancel-btn {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #94a3b8;
    padding: 7px 14px;
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
  }

  .save-btn {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    border: none;
    color: #fff;
    padding: 7px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* =========================================================================
     LIGHT THEME OVERRIDES (matches rest of SVAR / OnMyChat)
     ========================================================================= */
  .krea-studio-root.light-theme {
    background: #f1f5f9;
    color: #0f172a;
  }

  /* Header */
  .krea-studio-root.light-theme .studio-header {
    background: #f8fafc;
    border-bottom: 1px solid #e2e8f0;
  }

  .krea-studio-root.light-theme .sidebar-toggle-btn {
    color: #64748b;
  }
  .krea-studio-root.light-theme .sidebar-toggle-btn:hover {
    background: #e2e8f0;
    color: #0f172a;
  }

  .krea-studio-root.light-theme .turbo-pill {
    background: #ede9fe;
    color: #6d28d9;
    border-color: #ddd6fe;
  }

  .krea-studio-root.light-theme .header-subtitle {
    color: #64748b;
  }

  .krea-studio-root.light-theme .header-tabs {
    background: #e2e8f0;
    border-color: #cbd5e1;
  }

  .krea-studio-root.light-theme .tab-btn {
    color: #475569;
  }
  .krea-studio-root.light-theme .tab-btn:hover {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .tab-btn.active {
    background: #ffffff;
    color: #0f172a;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }
  .krea-studio-root.light-theme .tab-btn .badge {
    background: #e2e8f0;
    color: #475569;
  }
  .krea-studio-root.light-theme .tab-btn.active .badge {
    background: #f1f5f9;
    color: #0f172a;
  }

  .krea-studio-root.light-theme .icon-btn {
    border-color: #cbd5e1;
    color: #64748b;
  }
  .krea-studio-root.light-theme .icon-btn:hover {
    background: #e2e8f0;
    color: #0f172a;
  }

  /* Main & Sections */
  .krea-studio-root.light-theme .section-desc h3 {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .section-desc p {
    color: #64748b;
  }

  /* Personas */
  .krea-studio-root.light-theme .persona-card {
    background: #ffffff;
    border-color: rgba(0, 0, 0, 0.08);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
  }
  .krea-studio-root.light-theme .persona-card:hover {
    background: #ffffff;
    border-color: #8b5cf6;
    box-shadow: 0 6px 18px rgba(139, 92, 246, 0.15);
  }
  .krea-studio-root.light-theme .persona-card.selected {
    border-color: #8b5cf6;
    background: #f5f3ff;
    box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.3), 0 6px 18px rgba(139, 92, 246, 0.12);
  }
  .krea-studio-root.light-theme .persona-name {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .persona-title-chip {
    color: #7c3aed;
    background: #ede9fe;
  }
  .krea-studio-root.light-theme .persona-passport {
    color: #475569;
  }
  .krea-studio-root.light-theme .persona-actions {
    border-top-color: #f1f5f9;
  }
  .krea-studio-root.light-theme .card-action-btn {
    background: #f1f5f9;
    color: #334155;
  }
  .krea-studio-root.light-theme .card-action-btn:hover {
    background: #e2e8f0;
    color: #0f172a;
  }
  .krea-studio-root.light-theme .card-action-btn.select-btn.active {
    background: #8b5cf6;
    color: #ffffff;
  }
  .krea-studio-root.light-theme .card-action-btn.danger:hover {
    background: #fee2e2;
    color: #dc2626;
  }
  .krea-studio-root.light-theme .go-gallery-btn {
    background: #ede9fe;
    border: 1.5px solid #8b5cf6;
    color: #5b21b6;
    box-shadow: 0 1px 4px rgba(139, 92, 246, 0.15);
  }
  .krea-studio-root.light-theme .go-gallery-btn:hover {
    background: #7c3aed;
    border-color: #6d28d9;
    color: #ffffff;
    box-shadow: 0 4px 14px rgba(109, 40, 217, 0.3);
  }
  .krea-studio-root.light-theme .add-more-personas-btn {
    background: #f8fafc;
    border-color: #cbd5e1;
    color: #64748b;
  }
  .krea-studio-root.light-theme .add-more-personas-btn:hover {
    background: #ede9fe;
    border-color: #8b5cf6;
    color: #6d28d9;
  }
  .krea-studio-root.light-theme .add-new-slot {
    border-color: #cbd5e1;
    background: #ffffff;
  }
  .krea-studio-root.light-theme .add-new-slot:hover {
    border-color: #8b5cf6;
    background: #faf5ff;
  }
  .krea-studio-root.light-theme .add-slot-circle {
    background: #ede9fe;
    color: #7c3aed;
  }
  .krea-studio-root.light-theme .add-slot-label {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .add-slot-hint {
    color: #64748b;
  }

  /* Gallery */
  .krea-studio-root.light-theme .empty-gallery h3 {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .empty-gallery p {
    color: #64748b;
  }
  .krea-studio-root.light-theme .sug-pill {
    background: #ffffff;
    border-color: #cbd5e1;
    color: #6d28d9;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  }
  .krea-studio-root.light-theme .sug-pill:hover {
    background: #ede9fe;
    border-color: #a78bfa;
    color: #5b21b6;
  }
  .krea-studio-root.light-theme .gallery-card {
    background: #ffffff;
    border-color: rgba(0, 0, 0, 0.08);
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.05);
  }
  .krea-studio-root.light-theme .gallery-card:hover {
    border-color: #8b5cf6;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1);
  }
  .krea-studio-root.light-theme .card-footer-info {
    background: #ffffff;
    border-top: 1px solid #f1f5f9;
  }
  .krea-studio-root.light-theme .card-toolbar .toolbar-btn {
    color: #64748b;
  }
  .krea-studio-root.light-theme .card-toolbar .toolbar-btn:hover {
    background: rgba(0, 0, 0, 0.06);
    color: #0f172a;
  }
  .krea-studio-root.light-theme .card-title {
    color: #334155;
  }
  .krea-studio-root.light-theme .card-title {
    color: #1e293b;
  }
  .krea-studio-root.light-theme .persona-tag {
    background: #ede9fe;
    color: #6d28d9;
  }

  /* Composer & Bottom Panel */
  .krea-studio-root.light-theme .studio-composer {
    background: linear-gradient(180deg, rgba(241, 245, 249, 0) 0%, rgba(241, 245, 249, 0.98) 25%);
    border-top: none;
    box-shadow: none;
  }
  .krea-studio-root.light-theme .active-persona-pill {
    background: #ede9fe;
    border-color: #c4b5fd;
  }
  .krea-studio-root.light-theme .pill-name {
    color: #5b21b6;
  }
  .krea-studio-root.light-theme .pill-hint {
    color: #6d28d9;
  }
  .krea-studio-root.light-theme .pill-clear-btn {
    color: #7c3aed;
  }
  .krea-studio-root.light-theme .pick-persona-btn,
  .krea-studio-root.light-theme .toggle-tokens-btn,
  .krea-studio-root.light-theme .toggle-sliders-btn,
  .krea-studio-root.light-theme .advanced-gear-btn {
    background: #ffffff;
    border: 1px solid #c4b5fd;
    color: #6d28d9;
    box-shadow: 0 1px 3px rgba(109, 40, 217, 0.06);
  }
  .krea-studio-root.light-theme .pick-persona-btn:hover,
  .krea-studio-root.light-theme .toggle-tokens-btn:hover,
  .krea-studio-root.light-theme .toggle-sliders-btn:hover,
  .krea-studio-root.light-theme .advanced-gear-btn:hover {
    background: #f5f3ff;
    color: #5b21b6;
    border-color: #a78bfa;
  }
  .krea-studio-root.light-theme .toggle-tokens-btn.open,
  .krea-studio-root.light-theme .toggle-tokens-btn.active,
  .krea-studio-root.light-theme .toggle-sliders-btn.open,
  .krea-studio-root.light-theme .advanced-gear-btn.active {
    color: #6d28d9;
    border-color: #c4b5fd;
    background: #f5f3ff;
  }
  .krea-studio-root.light-theme .sliders-panel {
    background: #ffffff;
    border-color: #cbd5e1;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
  }
  .krea-studio-root.light-theme .slider-header,
  .krea-studio-root.light-theme .select-label {
    color: #475569;
  }
  .krea-studio-root.light-theme .slider-val {
    color: #7c3aed;
  }
  .krea-studio-root.light-theme .slider-ticks {
    color: #94a3b8;
  }
  .krea-studio-root.light-theme .dropdown-trigger-btn {
    background: #ffffff;
    border-color: #cbd5e1;
    color: #1e293b;
  }

  .krea-studio-root.light-theme .dropdown-trigger-btn:hover {
    background: #f8fafc;
    border-color: #94a3b8;
  }

  .krea-studio-root.light-theme .dropdown-trigger-btn.active {
    background: #ede9fe;
    border-color: #8b5cf6;
    color: #5b21b6;
    box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.15);
  }

  .krea-studio-root.light-theme .dropdown-trigger-btn.has-style {
    background: #ede9fe;
    border-color: #a78bfa;
    color: #5b21b6;
  }

  .krea-studio-root.light-theme .dropdown-trigger-btn.has-archetype {
    background: #fdf2f8;
    border-color: #f472b6;
    color: #9d174d;
  }

  .krea-studio-root.light-theme .dropdown-popup-menu {
    background: #ffffff;
    border-color: #e2e8f0;
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.05);
  }

  .krea-studio-root.light-theme .popup-menu-header {
    border-bottom-color: #f1f5f9;
    color: #475569;
  }

  .krea-studio-root.light-theme .popup-option-card {
    background: transparent;
    border-color: transparent;
  }

  .krea-studio-root.light-theme .popup-option-card:hover {
    background: #f8fafc;
  }

  .krea-studio-root.light-theme .popup-option-card.selected {
    background: #f5f3ff;
    border-color: #ddd6fe;
  }

  .krea-studio-root.light-theme .archetype-popup .popup-option-card.selected {
    background: #fdf2f8;
    border-color: #fbcfe8;
  }

  .krea-studio-root.light-theme .popup-option-row {
    color: #0f172a;
  }

  .krea-studio-root.light-theme .popup-option-item {
    color: #0f172a;
  }

  .krea-studio-root.light-theme .popup-option-item:hover {
    background: #f8fafc;
  }

  .krea-studio-root.light-theme .popup-option-item.selected {
    background: #ede9fe;
    color: #5b21b6;
  }

  .krea-studio-root.light-theme .archetype-popup .popup-option-item.selected {
    background: #fdf2f8;
    color: #9d174d;
  }

  .krea-studio-root.light-theme .option-label {
    color: #0f172a;
    font-weight: 600;
  }

  .krea-studio-root.light-theme .popup-option-card.selected .option-label {
    color: #4c1d95;
    font-weight: 700;
  }

  .krea-studio-root.light-theme .archetype-popup .popup-option-card.selected .option-label {
    color: #831843;
    font-weight: 700;
  }

  .krea-studio-root.light-theme .option-desc {
    color: #64748b;
  }

  .krea-studio-root.light-theme .popup-option-card.selected .option-desc {
    color: #6d28d9;
  }

  .krea-studio-root.light-theme .archetype-popup .popup-option-card.selected .option-desc {
    color: #be185d;
  }

  .krea-studio-root.light-theme .inline-weight-slider {
    background: #cbd5e1;
    accent-color: #7c3aed;
  }

  .krea-studio-root.light-theme .inline-weight-slider::-webkit-slider-thumb {
    background: #7c3aed;
    border: 2px solid #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  }

  .krea-studio-root.light-theme .inline-weight-slider::-moz-range-thumb {
    background: #7c3aed;
    border: 2px solid #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  }

  .krea-studio-root.light-theme .archetype-popup .inline-weight-slider {
    accent-color: #db2777;
  }

  .krea-studio-root.light-theme .archetype-popup .inline-weight-slider::-webkit-slider-thumb {
    background: #db2777;
    border: 2px solid #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  }

  .krea-studio-root.light-theme .archetype-popup .inline-weight-slider::-moz-range-thumb {
    background: #db2777;
    border: 2px solid #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  }

  .krea-studio-root.light-theme .inline-weight-val {
    color: #5b21b6;
    font-weight: 700;
  }

  .krea-studio-root.light-theme .archetype-popup .inline-weight-val {
    color: #9d174d;
    font-weight: 700;
  }

  .krea-studio-root.light-theme .popup-menu-footer {
    border-top-color: #f1f5f9;
    background: #ffffff;
  }

  .krea-studio-root.light-theme .popup-count-hint {
    color: #475569;
  }

  .krea-studio-root.light-theme .detail-val,
  .krea-studio-root.light-theme .slider-val {
    color: #6d28d9;
    font-weight: 700;
  }

  .krea-studio-root.light-theme .detail-header,
  .krea-studio-root.light-theme .slider-header {
    color: #475569;
  }

  .krea-studio-root.light-theme .detail-ticks,
  .krea-studio-root.light-theme .slider-ticks {
    color: #64748b;
  }

  .krea-studio-root.light-theme .slider-input {
    background: #cbd5e1;
  }

  .krea-studio-root.light-theme .option-check {
    color: #7c3aed;
  }

  .krea-studio-root.light-theme .archetype-popup .option-check {
    color: #db2777;
  }

  .krea-studio-root.light-theme .option-check-icon {
    border-color: #cbd5e1;
    background: #ffffff;
  }

  .krea-studio-root.light-theme .option-check-icon.checked {
    background: #7c3aed;
    border-color: #7c3aed;
    color: #ffffff;
    box-shadow: 0 1px 3px rgba(124, 58, 237, 0.25);
  }

  .krea-studio-root.light-theme .archetype-popup .option-check-icon.checked {
    background: #ec4899;
    border-color: #ec4899;
    color: #ffffff;
    box-shadow: 0 1px 3px rgba(236, 72, 153, 0.25);
  }

  .krea-studio-root.light-theme .aspect-chip {
    background: #f1f5f9;
    border-color: #e2e8f0;
    color: #475569;
  }
  .krea-studio-root.light-theme .aspect-chip:hover {
    background: #e2e8f0;
    color: #0f172a;
  }
  .krea-studio-root.light-theme .aspect-chip.active {
    background: #ede9fe;
    border-color: #8b5cf6;
    color: #6d28d9;
  }
  .krea-studio-root.light-theme .pill-toggle-wrapper {
    background: #f1f5f9;
    border-color: #cbd5e1;
  }
  .krea-studio-root.light-theme .pill-btn {
    color: #475569;
  }
  .krea-studio-root.light-theme .pill-btn:hover {
    color: #0f172a;
    background: #e2e8f0;
  }
  .krea-studio-root.light-theme .pill-btn.active {
    background: linear-gradient(135deg, #7c3aed, #6366f1);
    color: #ffffff;
    box-shadow: 0 2px 6px rgba(124, 58, 237, 0.25);
  }
  .krea-studio-root.light-theme .model-pill-hint {
    color: #6d28d9;
  }

  .krea-studio-root.light-theme .advanced-gear-btn svg {
    color: #7c3aed;
  }
  .krea-studio-root.light-theme .advanced-gear-btn:hover {
    background: #ede9fe;
    border-color: #8b5cf6;
    color: #4c1d95;
  }
  .krea-studio-root.light-theme .advanced-gear-btn.active {
    background: #ede9fe;
    border-color: #7c3aed;
    color: #5b21b6;
    box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.15);
  }
  .krea-studio-root.light-theme .advanced-popup {
    background: #ffffff;
    border-color: #e2e8f0;
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.05);
  }
  .krea-studio-root.light-theme .advanced-popup .setting-name {
    color: #1e293b;
  }
  .krea-studio-root.light-theme .advanced-popup .setting-val-badge {
    color: #6d28d9;
    background: #ede9fe;
    border-color: #c4b5fd;
  }
  .krea-studio-root.light-theme .advanced-popup .setting-subtext {
    color: #64748b;
  }
  .krea-studio-root.light-theme .advanced-popup .advanced-slider {
    background: #cbd5e1;
    accent-color: #7c3aed;
  }
  .krea-studio-root.light-theme .param-card {
    background: #f8fafc;
    border-color: #e2e8f0;
  }
  .krea-studio-root.light-theme .persona-pill {
    background: #ede9fe;
    border-color: #c4b5fd;
    color: #5b21b6;
  }
  .krea-studio-root.light-theme .style-pill {
    background: #dbeafe;
    border-color: #93c5fd;
    color: #1e40af;
  }
  .krea-studio-root.light-theme .archetype-pill {
    background: #fce7f3;
    border-color: #f472b6;
    color: #9d174d;
  }
  .krea-studio-root.light-theme .tokens-preview-panel {
    background: #ffffff;
    border-color: #cbd5e1;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  }
  .krea-studio-root.light-theme .preview-title {
    color: #6d28d9;
  }
  .krea-studio-root.light-theme .token-text {
    color: #334155;
  }
  .krea-studio-root.light-theme .prompt-textarea {
    background: #ffffff;
    border-color: #cbd5e1;
    color: #0f172a;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }
  .krea-studio-root.light-theme .prompt-textarea::placeholder {
    color: #94a3b8;
  }
  .krea-studio-root.light-theme .prompt-textarea:focus {
    border-color: #8b5cf6;
    box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.15);
  }
  .krea-studio-root.light-theme .random-idea-btn {
    background: #ffffff;
    border-color: #cbd5e1;
    color: #475569;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
  }
  .krea-studio-root.light-theme .random-idea-btn:hover {
    background: #f8fafc;
    color: #0f172a;
  }
  .krea-studio-root.light-theme .prompts-history-btn {
    background: #ffffff;
    border-color: #cbd5e1;
    color: #64748b;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
  }
  .krea-studio-root.light-theme .prompts-history-btn:hover,
  .krea-studio-root.light-theme .prompts-history-btn.active {
    background: #f5f3ff;
    border-color: #7c3aed;
    color: #7c3aed;
  }
  .krea-studio-root.light-theme .attach-ref-btn {
    background: #ffffff;
    border-color: #cbd5e1;
    color: #64748b;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
  }
  .krea-studio-root.light-theme .attach-ref-btn:hover,
  .krea-studio-root.light-theme .attach-ref-btn.active {
    background: #f5f3ff;
    border-color: #7c3aed;
    color: #7c3aed;
  }
  .krea-studio-root.light-theme .ref-badge-num {
    border-color: #ffffff;
  }
  .krea-studio-root.light-theme .attached-refs-bar {
    background: #ffffff;
    border-color: #e2e8f0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }
  .krea-studio-root.light-theme .refs-label {
    color: #64748b;
  }
  .krea-studio-root.light-theme .ref-chip {
    background: #f1f5f9;
    border-color: #cbd5e1;
    color: #1e293b;
  }
  .krea-studio-root.light-theme .add-ref-mini-btn {
    background: #ffffff;
    border-color: #cbd5e1;
    color: #475569;
  }
  .krea-studio-root.light-theme .add-ref-mini-btn:hover {
    background: #f5f3ff;
    border-color: #7c3aed;
    color: #7c3aed;
  }
  .krea-studio-root.light-theme .prompts-popup {
    background: #ffffff;
    border-color: #e2e8f0;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.12);
  }
  .krea-studio-root.light-theme .prompts-popup-header {
    border-bottom-color: #f1f5f9;
  }
  .krea-studio-root.light-theme .prompts-header-title {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .prompts-popup-close {
    color: #64748b;
  }
  .krea-studio-root.light-theme .prompts-popup-close:hover {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .prompts-search-wrap {
    border-bottom-color: #f1f5f9;
  }
  .krea-studio-root.light-theme .prompts-search-input {
    background: #f8fafc;
    border-color: #cbd5e1;
    color: #0f172a;
  }
  .krea-studio-root.light-theme .prompt-item:hover {
    background: #f8fafc;
  }
  .krea-studio-root.light-theme .prompt-item-text {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .prompt-item-meta {
    color: #64748b;
  }
  .krea-studio-root.light-theme .prompt-style-badge {
    background: #ede9fe;
    color: #7c3aed;
  }
  .krea-studio-root.light-theme .prompt-delete-btn {
    color: #94a3b8;
  }
  .krea-studio-root.light-theme .prompts-empty-state {
    color: #64748b;
  }

  /* Modal */
  .krea-studio-root.light-theme .persona-modal-card {
    background: #ffffff;
    border-color: #e2e8f0;
    color: #0f172a;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.15);
  }
  .krea-studio-root.light-theme .modal-header {
    border-bottom-color: #f1f5f9;
  }
  .krea-studio-root.light-theme .modal-header h3 {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .modal-close-btn {
    color: #64748b;
  }
  .krea-studio-root.light-theme .modal-close-btn:hover {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .modal-field label {
    color: #334155;
  }
  .krea-studio-root.light-theme .modal-input,
  .krea-studio-root.light-theme .modal-textarea {
    background: #f8fafc;
    border-color: #cbd5e1;
    color: #0f172a;
  }
  .krea-studio-root.light-theme .field-hint {
    color: #64748b;
  }
  .krea-studio-root.light-theme .archetype-card {
    background: #f8fafc;
    border-color: #e2e8f0;
  }
  .krea-studio-root.light-theme .archetype-card:hover {
    background: #f1f5f9;
    border-color: #cbd5e1;
  }
  .krea-studio-root.light-theme .archetype-card.active {
    background: #ede9fe;
    border-color: #8b5cf6;
  }
  .krea-studio-root.light-theme .arch-name {
    color: #0f172a;
  }
  .krea-studio-root.light-theme .arch-hint {
    color: #64748b;
  }
  .krea-studio-root.light-theme .generated-persona-card {
    background: #f8fafc;
    border-color: #e2e8f0;
  }
  .krea-studio-root.light-theme .avatar-generator-card {
    background: #f8fafc;
    border-color: #e2e8f0;
  }
  .krea-studio-root.light-theme .archetype-select {
    background: #ffffff;
    border-color: #cbd5e1;
    color: #0f172a;
  }
  .krea-studio-root.light-theme .archetype-select option {
    background: #ffffff;
    color: #0f172a;
  }
  .krea-studio-root.light-theme .avatar-empty-box {
    background: #f1f5f9;
    border-color: #cbd5e1;
    color: #94a3b8;
  }
  .krea-studio-root.light-theme .modal-footer {
    background: #f8fafc;
    border-top-color: #e2e8f0;
  }
  .krea-studio-root.light-theme .cancel-btn {
    border-color: #cbd5e1;
    color: #475569;
  }
  .krea-studio-root.light-theme .cancel-btn:hover {
    background: #e2e8f0;
    color: #0f172a;
  }

  /* ── Custom Confirmation Modal ─────────────────── */
  .confirm-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 16px;
  }

  .confirm-modal-box {
    background: #1e232d;
    border: 1px solid #30363d;
    border-radius: 14px;
    width: 440px;
    max-width: 92vw;
    padding: 24px;
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.6);
    color: #e6edf3;
    font-family: inherit;
    display: flex;
    flex-direction: column;
  }

  .confirm-modal-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }

  .confirm-modal-header h3 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
    color: #f0f6fc;
  }

  .confirm-danger-icon {
    color: #f85149;
    flex-shrink: 0;
  }

  .confirm-modal-body p {
    margin: 0 0 8px 0;
    font-size: 0.95rem;
    line-height: 1.5;
    color: #c9d1d9;
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  .confirm-modal-body strong {
    word-break: break-word;
    overflow-wrap: anywhere;
    color: #ffffff;
    font-weight: 600;
  }

  .confirm-modal-subtext {
    font-size: 0.85rem !important;
    color: #8b949e !important;
    margin-bottom: 0 !important;
  }

  .confirm-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 22px;
  }

  .confirm-btn {
    padding: 9px 18px;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }

  .confirm-btn:active {
    transform: scale(0.98);
  }

  .confirm-btn.cancel {
    background: #21262d;
    border-color: #30363d;
    color: #c9d1d9;
  }

  .confirm-btn.cancel:hover {
    background: #30363d;
  }

  .confirm-btn.danger {
    background: #da3633;
    color: #ffffff;
    border-color: rgba(255, 255, 255, 0.1);
  }

  .confirm-btn.danger:hover {
    background: #b82a28;
  }

  .confirm-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Confirmation Modal (Light Theme) */
  .krea-studio-root.light-theme .confirm-modal-box {
    background: #ffffff;
    border-color: #e2e8f0;
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.15);
    color: #0f172a;
  }

  .krea-studio-root.light-theme .confirm-modal-header h3 {
    color: #0f172a;
  }

  .krea-studio-root.light-theme .confirm-modal-body p {
    color: #334155;
  }

  .krea-studio-root.light-theme .confirm-modal-body strong {
    color: #0f172a;
  }

  .krea-studio-root.light-theme .confirm-modal-subtext {
    color: #64748b !important;
  }

  .krea-studio-root.light-theme .confirm-btn.cancel {
    background: #f1f5f9;
    border-color: #cbd5e1;
    color: #334155;
  }

  .krea-studio-root.light-theme .confirm-btn.cancel:hover {
    background: #e2e8f0;
  }

  .krea-studio-root.light-theme .confirm-btn.danger {
    background: #ef4444;
    color: #ffffff;
  }

  .krea-studio-root.light-theme .confirm-btn.danger:hover {
    background: #dc2626;
  }

  /* Attached References Bar & Chips */
  .attached-refs-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    background: rgba(15, 23, 42, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    margin-bottom: 8px;
    backdrop-filter: blur(12px);
  }

  .refs-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #94a3b8;
  }

  .refs-list {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .ref-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(30, 41, 59, 0.85);
    border: 1px solid rgba(139, 92, 246, 0.4);
    padding: 3px 8px 3px 4px;
    border-radius: 20px;
    font-size: 0.78rem;
    color: #f1f5f9;
  }

  .ref-chip-idx {
    font-size: 0.7rem;
    font-weight: 700;
    background: #8b5cf6;
    color: #ffffff;
    padding: 1px 6px;
    border-radius: 10px;
  }

  .ref-chip-img {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    object-fit: cover;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .ref-chip-title {
    max-width: 120px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ref-chip-del {
    background: transparent;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0 2px;
    line-height: 1;
    transition: color 0.15s;
  }

  .ref-chip-del:hover {
    color: #ef4444;
  }

  .add-ref-mini-btn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px dashed rgba(255, 255, 255, 0.2);
    color: #cbd5e1;
    font-size: 0.75rem;
    padding: 3px 10px;
    border-radius: 14px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .add-ref-mini-btn:hover {
    background: rgba(139, 92, 246, 0.15);
    border-color: #8b5cf6;
    color: #c084fc;
  }

  .attach-ref-btn {
    position: relative;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #94a3b8;
    width: 42px;
    height: 42px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .attach-ref-btn svg {
    display: block;
    transition: transform 0.2s ease;
  }

  .attach-ref-btn:hover svg {
    transform: scale(1.08);
  }

  .spin-icon {
    animation: spin-ref 0.8s linear infinite;
  }

  @keyframes spin-ref {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .attach-ref-btn:hover,
  .attach-ref-btn.active {
    background: rgba(139, 92, 246, 0.2);
    border-color: #8b5cf6;
    color: #c084fc;
  }

  .ref-badge-num {
    position: absolute;
    top: -4px;
    right: -4px;
    background: #8b5cf6;
    color: #ffffff;
    font-size: 0.65rem;
    font-weight: 700;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid #0f172a;
  }

  .card-ref-btn {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: #cbd5e1;
    font-size: 0.85rem;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s ease, background 0.2s ease;
  }

  .gallery-card:hover .card-ref-btn {
    opacity: 1;
  }

  .card-ref-btn:hover {
    background: rgba(139, 92, 246, 0.4);
    color: #ffffff;
  }

  /* Header Mode Switcher (CyberCraft / Krea Studio) */
  .header-mode-toggle-group {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .header-count-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    padding: 0 8px;
    font-size: 0.78rem;
    font-weight: 600;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.12);
    color: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  }
  :global(.light-theme) .header-count-pill {
    background: rgba(0, 0, 0, 0.06);
    color: #334155;
    border-color: rgba(0, 0, 0, 0.08);
  }
  .header-mode-toggle {
    display: inline-flex;
    align-items: center;
    background: rgba(15, 23, 42, 0.55);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 9999px;
    padding: 3px;
    gap: 2px;
  }
  :global(.light-theme) .header-mode-toggle {
    background: rgba(241, 245, 249, 0.9);
    border-color: rgba(0, 0, 0, 0.1);
  }
  .mode-toggle-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 13px;
    border-radius: 9999px;
    border: 1px solid transparent;
    background: transparent;
    color: rgba(255, 255, 255, 0.65);
    font-size: 0.88rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    user-select: none;
  }
  :global(.light-theme) .mode-toggle-btn {
    color: rgba(30, 41, 59, 0.7);
  }
  .mode-toggle-btn:hover:not(.active) {
    color: rgba(255, 255, 255, 0.95);
    background: rgba(255, 255, 255, 0.08);
  }
  :global(.light-theme) .mode-toggle-btn:hover:not(.active) {
    color: #0f172a;
    background: rgba(0, 0, 0, 0.05);
  }
  .mode-toggle-btn.active {
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.4), rgba(168, 85, 247, 0.4));
    border-color: rgba(168, 85, 247, 0.5);
    color: #fff;
    font-weight: 600;
    box-shadow: 0 2px 10px rgba(99, 102, 241, 0.25);
  }
  :global(.light-theme) .mode-toggle-btn.active {
    background: linear-gradient(135deg, rgba(99, 102, 241, 0.18), rgba(168, 85, 247, 0.18));
    border-color: rgba(99, 102, 241, 0.4);
    color: #4338ca;
  }
  .mode-toggle-btn .mode-icon {
    font-size: 0.95rem;
  }

  .mode-text-short {
    display: none;
  }

  /* Responsive Mobile Layout (max-width: 640px) */
  @media (max-width: 640px) {
    .studio-header {
      flex-wrap: wrap;
      padding: 8px 10px;
      gap: 6px 8px;
    }

    .header-left {
      gap: 6px;
      flex: 1;
      min-width: 0;
    }

    .header-mode-toggle-group {
      gap: 4px;
    }

    .header-mode-toggle {
      padding: 2px;
      gap: 2px;
    }

    .mode-toggle-btn {
      padding: 4px 8px;
      font-size: 0.8rem;
      gap: 4px;
    }

    .header-count-pill {
      display: none;
    }

    .header-right {
      gap: 4px;
      flex-shrink: 0;
    }

    .header-right .icon-btn {
      width: 34px;
      height: 34px;
      padding: 4px;
    }

    /* Tabs (Gallery vs Personas) become a sleek full-width segmented control on row 2 */
    .header-tabs {
      order: 3;
      width: 100%;
      margin-top: 2px;
      padding: 3px;
      gap: 4px;
      border-radius: 12px;
      box-sizing: border-box;
    }

    .header-tabs .tab-btn {
      flex: 1;
      justify-content: center;
      padding: 6px 8px;
      font-size: 12px;
      gap: 6px;
    }

    /* Sticky Bottom Composer */
    .studio-composer {
      padding: 10px 10px 12px 10px;
    }

    .composer-controls-row {
      margin-bottom: 6px;
      gap: 4px;
      flex-wrap: nowrap;
      align-items: center;
      width: 100%;
      justify-content: space-between;
    }

    .composer-controls-right {
      margin-left: auto;
      justify-content: flex-end;
      gap: 4px;
      flex-wrap: nowrap;
      flex-shrink: 0;
    }

    .toggle-tokens-btn {
      display: none !important;
    }

    .pick-persona-btn,
    .active-persona-pill,
    .toggle-sliders-btn,
    .advanced-gear-btn {
      font-size: 11px;
      padding: 0 6px;
      gap: 4px;
      height: 26px;
      white-space: nowrap;
    }

    .pick-persona-btn {
      flex-shrink: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .toggle-sliders-btn,
    .advanced-gear-btn {
      flex-shrink: 0;
    }

    /* Input Row: prompt full-width on top, action buttons row below */
    .composer-input-row {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }

    .prompt-textarea {
      width: 100%;
      min-height: 46px;
      max-height: 120px;
      font-size: 15px;
      line-height: 20px;
      padding: 9px 12px;
      box-sizing: border-box;
    }

    .composer-actions {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .attach-ref-btn,
    .prompts-history-btn,
    .random-idea-btn {
      width: 40px;
      height: 40px;
      flex-shrink: 0;
    }

    .generate-submit-btn {
      flex: 1;
      min-width: 0;
      height: 40px;
      padding: 0 10px;
      font-size: 14px;
      justify-content: center;
    }

    /* Prompts popup */
    .prompts-popup {
      left: 10px;
      right: 10px;
      max-height: 60vh;
    }

    /* Sliders panel on mobile */
    .sliders-panel {
      grid-template-columns: 1fr;
      padding: 10px;
      gap: 10px;
      max-height: 45vh;
      overflow-y: auto;
    }

    .studio-main {
      padding: 10px 10px 240px 10px;
    }

    .gallery-grid {
      gap: 12px;
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 440px) {
    .mode-text-full {
      display: none;
    }
    .mode-text-short {
      display: inline;
    }
  }
</style>
