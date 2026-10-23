const nameInput = document.getElementById("name");
const themeSelect = document.getElementById("theme");
const disabledList = document.getElementById("disabled");
const saved = document.getElementById("saved");

let flashTimer;
function flash() {
  saved.classList.add("show");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => saved.classList.remove("show"), 1200);
}

function renderDisabled(paths) {
  disabledList.replaceChildren();
  if (!paths.length) {
    const li = document.createElement("li");
    li.textContent = "None.";
    li.style.border = "0";
    disabledList.appendChild(li);
    return;
  }
  for (const path of paths) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = path;
    const button = document.createElement("button");
    button.textContent = "remove";
    button.addEventListener("click", () => {
      const next = paths.filter((p) => p !== path);
      chrome.storage.local.set({ disabled: next }, () => {
        renderDisabled(next);
        flash();
      });
    });
    li.append(span, button);
    disabledList.appendChild(li);
  }
}

chrome.storage.local.get(["name", "theme", "disabled"], (stored) => {
  nameInput.value = stored.name || "dan";
  themeSelect.value = stored.theme || "system";
  renderDisabled(stored.disabled || []);
});

nameInput.addEventListener("change", () => {
  const value = nameInput.value.trim() || "dan";
  nameInput.value = value;
  chrome.storage.local.set({ name: value }, flash);
});

themeSelect.addEventListener("change", () => chrome.storage.local.set({ theme: themeSelect.value }, flash));
