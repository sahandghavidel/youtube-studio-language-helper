(() => {
  "use strict";

  if (globalThis.__YOUTUBE_LANGUAGE_HELPER_LOADED__) return;
  globalThis.__YOUTUBE_LANGUAGE_HELPER_LOADED__ = true;

  const SELECTORS = Object.freeze({
    languageSection: "ytgn-video-languages-section",
    translationsTable: 'table[aria-label="Translations"]',
    translationRow: "ytgn-video-translation-row",
    captionsCell: "ytgn-video-translation-cell-captions",
    audioCell: "ytgn-video-translation-cell-audio",
    metadataCell: "ytgn-video-translation-cell-metadata",
    languageDialog: "ytgn-language-dialog",
    subtitleUploadFileInput: 'ytve-captions-editor-upload-dialog input#captions-file-loader[type="file"]',
    audioUploadFileInput: 'ytgn-audio-upload-dialog input#audio-file-loader[type="file"]',
    thumbnailFileInput: 'ytgn-language-dialog input#file-loader[type="file"]'
  });

  const TIMEOUTS = Object.freeze({ short: 8_000, normal: 20_000, upload: 180_000 });
  const ACTION_SETTLE_MS = 750;
  const STUDIO_SETTLE_MS = 2_500;
  const VIDEO_URL = /^https:\/\/studio\.youtube\.com\/video\/([^/?#]+)\/translations(?:[/?#]|$)/;
  const transfers = new Map();
  let pendingUpload = null;

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  }

  function normalizedText(element) {
    return String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function elementsByRole(role, root = document) {
    return Array.from(root.querySelectorAll(`[role="${role}"]`)).filter(visible);
  }

  function accessibleName(element) {
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => Array.from(element.querySelectorAll("[id]")).find((candidate) => candidate.id === id)
        || document.getElementById(id))
      .filter(Boolean)
      .map(normalizedText)
      .filter(Boolean)
      .join(" ");
    return (element.getAttribute("aria-label") || labelledBy || normalizedText(element)).trim();
  }

  function buttonsNamed(name, root = document) {
    return Array.from(root.querySelectorAll('button,[role="button"]'))
      .filter(visible)
      .filter((element) => accessibleName(element) === name || normalizedText(element) === name);
  }

  function exactOne(elements, operation, expected) {
    if (elements.length !== 1) {
      throw diagnosticError(operation, expected, `${elements.length} matching controls`, elements.length === 0);
    }
    return elements[0];
  }

  function diagnosticError(operation, expected, found, retrySafe = true) {
    const error = new Error(`${operation}: expected ${expected}; found ${found}.`);
    error.diagnostic = { operation, expected, found, retrySafe };
    return error;
  }

  function click(element) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.click();
  }

  function pause(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function waitForStableEnabled(button, operation) {
    await waitFor(() => button?.isConnected
      && !button.hasAttribute("disabled")
      && button.getAttribute("aria-disabled") !== "true", { operation });
    await pause(ACTION_SETTLE_MS);
    return waitFor(() => button?.isConnected
      && !button.hasAttribute("disabled")
      && button.getAttribute("aria-disabled") !== "true", { operation });
  }

  function waitFor(predicate, { timeout = TIMEOUTS.normal, operation = "wait", root = document } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error = null) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const check = () => {
        try {
          const value = predicate();
          if (value) finish(value);
        } catch (error) {
          finish(null, error);
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(null, diagnosticError(operation, "a visible verified UI state", "timeout", true)), timeout);
      check();
    });
  }

  function inspectPage() {
    const match = location.href.match(VIDEO_URL);
    const dashboardLink = document.querySelector('a[href^="/channel/"]');
    const channelId = dashboardLink?.getAttribute("href")?.match(/^\/channel\/([^/]+)/)?.[1] || null;
    const thumbnail = document.querySelector('img[aria-label^="Video thumbnail:"]');
    const navigationTitle = document.querySelector("ytcp-navigation-drawer #entity-name");
    const videoTitle = thumbnail?.getAttribute("aria-label")?.replace(/^Video thumbnail:\s*/, "").trim()
      || normalizedText(navigationTitle)
      || null;
    const signedIn = Boolean(document.querySelector('button[aria-label="Account"], [aria-label="Account"]'));
    const onLanguagesPage = Boolean(match && document.querySelector(SELECTORS.languageSection));
    return {
      ok: onLanguagesPage && signedIn && Boolean(channelId && videoTitle),
      onLanguagesPage,
      signedIn,
      videoId: match?.[1] || null,
      channelId,
      channelName: null,
      videoTitle,
      url: location.href
    };
  }

  function assertBinding(binding) {
    const page = inspectPage();
    if (!page.signedIn) throw diagnosticError("verify-page", "a signed-in YouTube Studio account", "signed out", true);
    if (!page.onLanguagesPage) throw diagnosticError("verify-page", "the bound video's Languages page", page.url, true);
    if (page.videoId !== binding.videoId) throw diagnosticError("verify-video", binding.videoId, page.videoId || "no video ID", true);
    if (binding.channelId && page.channelId !== binding.channelId) throw diagnosticError("verify-channel", binding.channelId, page.channelId || "no channel ID", true);
    return page;
  }

  function translationRows() {
    return Array.from(document.querySelectorAll(SELECTORS.translationRow));
  }

  function rowLanguage(row) {
    const firstCell = row.querySelector("td");
    const button = firstCell?.querySelector("button");
    return normalizedText(button || firstCell);
  }

  function findRow(language) {
    const matches = translationRows().filter((row) => rowLanguage(row) === language);
    if (matches.length > 1) throw diagnosticError("find-language-row", `one exact ${language} row`, `${matches.length} rows`, false);
    return matches[0] || null;
  }

  function inspectRows() {
    return translationRows().map((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      return {
        language: rowLanguage(row),
        audio: normalizedText(cells[1]) || "–",
        subtitle: normalizedText(cells[2]) || "–",
        metadata: normalizedText(cells[3]) || "–"
      };
    });
  }

  function currentLanguageDialog(language) {
    const dialogs = Array.from(document.querySelectorAll(SELECTORS.languageDialog));
    const matches = dialogs.filter((dialog) => {
      // Studio's ytgn-language-dialog host can have a zero-height rectangle even
      // while its nested tp-yt-paper-dialog is visibly open. Treat the host as
      // open when either it or a dialog descendant is visible.
      if (!languageDialogVisible(dialog)) return false;
      return Array.from(dialog.querySelectorAll("h1,[role=heading]"))
        .some((element) => normalizedText(element) === language);
    });
    if (matches.length > 1) {
      throw diagnosticError("find-language-dialog", `one open ${language} dialog`, `${matches.length} dialogs`, false);
    }
    return matches[0] || null;
  }

  function languageDialogVisible(dialog) {
    if (!dialog?.isConnected) return false;
    if (visible(dialog)) return true;
    return Array.from(dialog.querySelectorAll('[role="dialog"],tp-yt-paper-dialog')).some(visible);
  }

  async function studioLanguageLabels() {
    const add = exactOne(buttonsNamed("Add language"), "list-studio-languages", "one Add language button");
    click(add);
    const listbox = await waitFor(() => elementsByRole("listbox")[0], { operation: "open-language-list" });
    const labels = Array.from(listbox.querySelectorAll('[role="option"]')).map(accessibleName).filter(Boolean);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    const closed = await waitFor(() => !elementsByRole("listbox").length, { operation: "close-language-list", timeout: 1_000 }).then(() => true).catch(() => false);
    if (!closed) {
      click(add);
      await waitFor(() => !elementsByRole("listbox").length, { operation: "close-language-list", timeout: TIMEOUTS.short });
    }
    return labels;
  }

  async function ensureLanguage(language) {
    const openDialog = currentLanguageDialog(language);
    if (openDialog) return { added: true, row: null, dialog: openDialog };
    const existing = findRow(language);
    if (existing) return { added: false, row: existing };
    const add = exactOne(buttonsNamed("Add language"), "add-language", "one Add language button");
    click(add);
    const listbox = await waitFor(() => elementsByRole("listbox")[0], { operation: "open-language-list" });
    const options = Array.from(listbox.querySelectorAll('[role="option"]')).filter(visible);
    const matches = options.filter((option) => accessibleName(option) === language);
    const option = exactOne(matches, "select-language", `one exact enabled ${language} option`);
    if (option.getAttribute("aria-disabled") === "true" || option.hasAttribute("disabled")) {
      throw diagnosticError("select-language", `enabled ${language}`, "disabled option", false);
    }
    click(option);
    const createdState = await waitFor(() => findRow(language) || currentLanguageDialog(language), { operation: "verify-added-language" });
    return createdState.matches?.(SELECTORS.translationRow)
      ? { added: true, row: createdState, dialog: null }
      : { added: true, row: null, dialog: createdState };
  }

  async function openLanguageDialog(language) {
    const alreadyOpen = currentLanguageDialog(language);
    if (alreadyOpen) return alreadyOpen;
    const row = findRow(language);
    if (!row) throw diagnosticError("open-language-details", `${language} row`, "row missing", true);
    const firstCell = row.querySelector("td");
    const buttons = Array.from(firstCell?.querySelectorAll("button") || []).filter(visible).filter((button) => normalizedText(button) === language);
    click(exactOne(buttons, "open-language-details", `one ${language} language button`));
    return waitFor(() => {
      const dialog = document.querySelector(SELECTORS.languageDialog);
      return dialog && languageDialogVisible(dialog) && normalizedText(dialog).includes(language) ? dialog : null;
    }, { operation: "verify-language-dialog" });
  }

  function closeLanguageDialog(dialog) {
    const cancel = buttonsNamed("Cancel", dialog);
    if (cancel.length === 1) click(cancel[0]);
  }

  function textBox(name, root) {
    const matches = Array.from(root.querySelectorAll('[role="textbox"],[contenteditable="true"]'))
      .filter(visible)
      .filter((element) => element.getAttribute("aria-label") === name);
    return exactOne(matches, "find-metadata-field", `${name} textbox`);
  }

  function setEditableValue(element, value) {
    element.focus();
    element.replaceChildren(document.createTextNode(value));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur();
  }

  async function processMetadata(language, payload) {
    const dialog = await openLanguageDialog(language);
    await pause(ACTION_SETTLE_MS);
    const titleBox = textBox("Title", dialog);
    const descriptionBox = textBox("Description", dialog);
    const existingTitle = titleBox.textContent || "";
    const existingDescription = descriptionBox.textContent || "";
    if (existingTitle === payload.title && existingDescription === payload.description) {
      closeLanguageDialog(dialog);
      return { outcome: "skipped", message: "Existing title and description already match." };
    }
    if ((existingTitle.trim() || existingDescription.trim()) && !payload.allowOverwrite) {
      closeLanguageDialog(dialog);
      return { outcome: "blocked", message: "Existing translated title or description differs; overwrite confirmation is required." };
    }
    setEditableValue(titleBox, payload.title);
    setEditableValue(descriptionBox, payload.description);
    const update = exactOne(buttonsNamed("Update", dialog), "save-metadata", "one Update button in the language dialog");
    await waitForStableEnabled(update, "enable-metadata-update");
    click(update);
    await waitFor(() => !languageDialogVisible(dialog), { operation: "verify-metadata-update", timeout: TIMEOUTS.normal });
    await waitFor(() => {
      const row = findRow(language);
      return row && /published/i.test(componentCellState(row, "metadata")) ? row : null;
    }, { operation: "verify-metadata-row", timeout: TIMEOUTS.normal });
    await pause(STUDIO_SETTLE_MS);
    return { outcome: "complete", message: "Translated title and description updated." };
  }

  function componentCellState(row, component) {
    const selector = component === "subtitle" ? SELECTORS.captionsCell : component === "audio" ? SELECTORS.audioCell : SELECTORS.metadataCell;
    const cell = row.querySelector(selector)?.closest("td") || row.querySelector(selector);
    return normalizedText(cell) || "–";
  }

  function hasExistingState(text) {
    return text && text !== "–" && !/^add$/i.test(text);
  }

  async function prepareSubtitle(language) {
    const pageRow = findRow(language);
    const state = componentCellState(pageRow, "subtitle");
    if (hasExistingState(state)) return { outcome: "blocked", message: `Existing subtitle state: ${state}. The extension will not replace it.` };

    const languageDialog = await openLanguageDialog(language);
    const row = await waitFor(() => mediaRow(languageDialog, "Subtitles"), {
      operation: "find-subtitle-media-row",
      root: languageDialog
    }).catch(() => null);
    if (!row) {
      closeLanguageDialog(languageDialog);
      throw diagnosticError("prepare-subtitle", "a rendered Manual subtitles row in language details", "row did not appear before timeout", true);
    }
    const detailState = normalizedText(row);
    if (/published|processing|draft/i.test(detailState) && !/\badd\b/i.test(detailState)) {
      closeLanguageDialog(languageDialog);
      return { outcome: "blocked", message: `Existing subtitle state: ${detailState}. The extension will not replace it.` };
    }
    const add = buttonsNamed("Add", row);
    if (add.length !== 1) {
      closeLanguageDialog(languageDialog);
      throw diagnosticError("prepare-subtitle", "one Manual subtitles Add control", `${add.length} controls`, true);
    }
    click(add[0]);

    const editorDialog = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter(visible)
      .find((dialog) => dialog.getAttribute("aria-label") === `${language} subtitles`), { operation: "open-subtitle-editor" });
    const uploadButtons = Array.from(editorDialog.querySelectorAll('button,[role="button"]'))
      .filter(visible)
      .filter((button) => /^Upload file(?:\s|$)/.test(normalizedText(button)));
    click(exactOne(uploadButtons, "open-subtitle-upload", "one Upload file button"));

    const timingDialog = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"],tp-yt-paper-dialog'))
      .filter(visible)
      .find((dialog) => normalizedText(dialog).includes("Select subtitles file type to upload")), { operation: "subtitle-timing-choice" });
    const withTiming = Array.from(timingDialog.querySelectorAll('input[type="radio"],[role="radio"]'))
      .filter((element) => accessibleName(element) === "With timing");
    const timingControl = exactOne(withTiming, "subtitle-timing-choice", "one With timing option");
    if (timingControl.getAttribute("aria-checked") !== "true" && !timingControl.checked) click(timingControl);

    const input = await waitFor(() => document.querySelector(SELECTORS.subtitleUploadFileInput), { operation: "find-subtitle-file-input" });
    pendingUpload = { component: "subtitle", language, input, editorDialog };
    return { outcome: "upload-ready", state };
  }

  function mediaRow(dialog, typeLabel) {
    const expectedName = typeLabel === "Subtitles" ? "Manual subtitles" : typeLabel;
    const matches = Array.from(dialog.querySelectorAll("tr")).filter((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      return cells.some((cell) => normalizedText(cell) === expectedName);
    });
    if (matches.length > 1) {
      throw diagnosticError("find-media-row", `one exact ${expectedName} row`, `${matches.length} rows`, false);
    }
    return matches[0] || null;
  }

  async function prepareAudio(language) {
    const dialog = await openLanguageDialog(language);
    const row = await waitFor(() => mediaRow(dialog, "Audio"), {
      operation: "find-audio-media-row",
      root: dialog
    }).catch(() => null);
    if (!row) {
      closeLanguageDialog(dialog);
      throw diagnosticError("prepare-audio", "a rendered Audio row in language details", "row did not appear before timeout", true);
    }
    const state = normalizedText(row);
    if (/auto-dubbed/i.test(state)) {
      closeLanguageDialog(dialog);
      return { outcome: "blocked", message: "An auto-dub already exists. YouTube requires deletion before manual upload, so audio was blocked." };
    }
    if (/published|processing|draft/i.test(state) && !/^audio\s+add$/i.test(state)) {
      closeLanguageDialog(dialog);
      return { outcome: "blocked", message: `Existing audio state: ${state}. The extension will not replace it.` };
    }
    const add = buttonsNamed("Add", row);
    if (add.length !== 1) {
      closeLanguageDialog(dialog);
      return { outcome: "blocked", message: `Studio did not expose a unique Audio Add control. Found: ${state || "empty row"}.` };
    }
    click(add[0]);
    const uploadDialog = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"],tp-yt-paper-dialog'))
      .filter(visible)
      .find((candidate) => accessibleName(candidate) === `${language} Audio`), { operation: "open-audio-upload" });
    const input = await waitFor(() => document.querySelector(SELECTORS.audioUploadFileInput), { operation: "find-audio-file-input" }).catch(() => null);
    if (!input) {
      const close = [...buttonsNamed("Cancel", uploadDialog), ...buttonsNamed("Close", uploadDialog)];
      if (close.length === 1) click(close[0]);
      closeLanguageDialog(dialog);
      return { outcome: "blocked", message: "Studio opened the audio dialog but did not expose a safe file input. No native file picker was opened." };
    }
    pendingUpload = { component: "audio", language, input };
    return { outcome: "upload-ready", state };
  }

  async function prepareThumbnail(language, allowOverwrite) {
    const dialog = await openLanguageDialog(language);
    const thumbnailRow = await waitFor(() => mediaRow(dialog, "Thumbnail"), {
      operation: "find-thumbnail-media-row",
      root: dialog
    }).catch(() => null);
    if (!thumbnailRow) {
      closeLanguageDialog(dialog);
      return { outcome: "blocked", message: "This Studio language dialog did not render a localized-thumbnail row before timeout." };
    }
    const text = normalizedText(thumbnailRow);
    if (/change|published/i.test(text) && !allowOverwrite) {
      closeLanguageDialog(dialog);
      return { outcome: "blocked", message: "A localized thumbnail already exists; overwrite confirmation is required." };
    }
    const addNames = allowOverwrite ? ["Change", "Add"] : ["Add"];
    const controls = addNames.flatMap((name) => buttonsNamed(name, thumbnailRow));
    if (controls.length !== 1) {
      closeLanguageDialog(dialog);
      return { outcome: "blocked", message: `Studio did not expose a unique thumbnail upload control. Found: ${text}.` };
    }
    const input = dialog.querySelector(SELECTORS.thumbnailFileInput) || document.querySelector(SELECTORS.thumbnailFileInput);
    if (!input) {
      closeLanguageDialog(dialog);
      throw diagnosticError("prepare-thumbnail", "localized thumbnail file input", "no input", true);
    }
    pendingUpload = { component: "thumbnail", language, input };
    return { outcome: "upload-ready", state: text };
  }

  async function prepareComponent(message) {
    assertBinding(message.binding);
    await ensureLanguage(message.targetLanguage);
    if (message.component === "metadata") return processMetadata(message.targetLanguage, message.payload);
    if (message.component === "subtitle") return prepareSubtitle(message.targetLanguage);
    if (message.component === "audio") return prepareAudio(message.targetLanguage);
    if (message.component === "thumbnail") return prepareThumbnail(message.targetLanguage, message.payload?.allowOverwrite);
    throw diagnosticError("prepare-component", "a supported component", message.component, false);
  }

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function attachPendingFile(transfer) {
    if (!pendingUpload || pendingUpload.component !== transfer.component || pendingUpload.language !== transfer.language) {
      throw diagnosticError("attach-file", `${transfer.component} input for ${transfer.language}`, "no matching prepared input", false);
    }
    const blob = new Blob(transfer.chunks, { type: transfer.mimeType || "application/octet-stream" });
    if (blob.size !== transfer.size) throw diagnosticError("attach-file", `${transfer.size} bytes`, `${blob.size} reconstructed bytes`, true);
    const file = new File([blob], transfer.name, { type: transfer.mimeType || "", lastModified: transfer.lastModified || Date.now() });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    pendingUpload.input.files = dataTransfer.files;
    pendingUpload.input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    pendingUpload.input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const result = await finalizeUpload(pendingUpload.component, pendingUpload.language);
    pendingUpload = null;
    return result;
  }

  async function finalizeUpload(component, language) {
    if (component === "subtitle") {
      const dialog = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter(visible)
        .find((candidate) => candidate.getAttribute("aria-label") === `${language} subtitles`), { operation: "subtitle-upload-dialog", timeout: TIMEOUTS.upload });
      const publish = await waitFor(() => {
        const matches = buttonsNamed("Publish", dialog).filter((button) => !button.hasAttribute("disabled"));
        return matches.length === 1 ? matches[0] : null;
      }, { operation: "subtitle-publish-ready", timeout: TIMEOUTS.upload });
      await waitForStableEnabled(publish, "subtitle-publish-stable");
      click(publish);
      await waitFor(() => {
        const row = findRow(language);
        return row && /published/i.test(componentCellState(row, "subtitle")) ? row : null;
      }, { operation: "verify-subtitle-published", timeout: TIMEOUTS.upload });
      const autoClosed = await waitFor(() => !visible(dialog), {
        operation: "wait-for-subtitle-editor-auto-close",
        timeout: 3_000
      }).then(() => true).catch(() => false);
      if (!autoClosed) {
        const close = exactOne(buttonsNamed("Close", dialog), "close-published-subtitle-editor", "one Close button");
        click(close);
        await waitFor(() => !visible(dialog), {
          operation: "verify-subtitle-editor-closed",
          timeout: TIMEOUTS.normal
        });
      }
      await pause(STUDIO_SETTLE_MS);
      return { outcome: "complete", message: "Subtitle uploaded and published." };
    }

    if (component === "audio") {
      const dialog = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter(visible)
        .find((candidate) => accessibleName(candidate) === `${language} Audio`), { operation: "audio-upload-dialog", timeout: TIMEOUTS.upload });
      const publish = await waitFor(() => {
        const matches = buttonsNamed("Publish", dialog).filter((button) => !button.hasAttribute("disabled"));
        return matches.length === 1 ? matches[0] : null;
      }, { operation: "audio-publish-ready", timeout: TIMEOUTS.upload });
      await waitForStableEnabled(publish, "audio-publish-stable");
      click(publish);
      await waitFor(() => {
        const row = findRow(language);
        const state = row ? componentCellState(row, "audio") : "";
        return /published|processing/i.test(state) ? row : null;
      }, { operation: "verify-audio-upload", timeout: TIMEOUTS.upload });
      await pause(STUDIO_SETTLE_MS);
      return { outcome: "complete", message: "Audio uploaded and accepted by Studio." };
    }

    if (component === "thumbnail") {
      const dialog = document.querySelector(SELECTORS.languageDialog);
      const update = await waitFor(() => {
        const matches = buttonsNamed("Update", dialog).filter((button) => !button.hasAttribute("disabled"));
        return matches.length === 1 ? matches[0] : null;
      }, { operation: "thumbnail-update-ready", timeout: TIMEOUTS.upload });
      await waitForStableEnabled(update, "thumbnail-update-stable");
      click(update);
      await waitFor(() => !languageDialogVisible(dialog), { operation: "verify-thumbnail-update", timeout: TIMEOUTS.upload });
      await pause(STUDIO_SETTLE_MS);
      return { outcome: "complete", message: "Localized thumbnail updated." };
    }

    throw diagnosticError("finalize-upload", "subtitle, audio, or thumbnail", component, false);
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "language-helper-file-transfer") return;
    let transfer = null;
    port.onMessage.addListener(async (message) => {
      try {
        if (message.type === "start") {
          transfer = { ...message, chunks: [], received: 0 };
          transfers.set(message.transferId, transfer);
          port.postMessage({ type: "ack", transferId: message.transferId, index: -1 });
          return;
        }
        if (!transfer || message.transferId !== transfer.transferId) throw new Error("Transfer is not initialized.");
        if (message.type === "chunk") {
          const bytes = decodeBase64(message.data);
          transfer.chunks.push(bytes);
          transfer.received += bytes.byteLength;
          port.postMessage({ type: "ack", transferId: transfer.transferId, index: message.index, received: transfer.received });
          return;
        }
        if (message.type === "end") {
          const result = await attachPendingFile(transfer);
          transfers.delete(transfer.transferId);
          port.postMessage({ type: "complete", transferId: transfer.transferId, result });
        }
      } catch (error) {
        if (transfer) transfers.delete(transfer.transferId);
        pendingUpload = null;
        port.postMessage({ type: "error", transferId: transfer?.transferId || message.transferId, error: serializeError(error) });
      }
    });
    port.onDisconnect.addListener(() => {
      if (transfer) transfers.delete(transfer.transferId);
      pendingUpload = null;
    });
  });

  function serializeError(error) {
    return {
      message: error?.message || String(error),
      diagnostic: error?.diagnostic || null
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    const respond = async () => {
      if (message.type === "PING") return { ok: true, page: inspectPage() };
      if (message.type === "INSPECT_PAGE") return { ok: true, page: inspectPage(), rows: inspectRows() };
      if (message.type === "DRY_RUN") {
        const page = assertBinding(message.binding);
        const studioLabels = await studioLanguageLabels();
        return { ok: true, page, rows: inspectRows(), studioLabels };
      }
      if (message.type === "PREPARE_COMPONENT") {
        const result = await prepareComponent(message);
        return { ok: true, result };
      }
      throw new Error(`Unknown message type: ${message.type}`);
    };
    respond().then(sendResponse).catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  });

  setInterval(() => {
    chrome.runtime.sendMessage({ type: "CONTENT_HEARTBEAT" }).catch(() => {});
  }, 30_000);
})();
