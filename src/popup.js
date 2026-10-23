const box = document.getElementById("access");

function render(allowed) {
  if (allowed) {
    box.className = "status ok";
    box.textContent = "File access is on — open a .md file and it opens as Threadmark.";
    return;
  }
  box.className = "status bad";
  box.textContent = "Threadmark can't read local files until you allow file access.";
  const link = document.createElement("button");
  link.className = "link";
  link.type = "button";
  link.textContent = "Open the extension setting";
  link.style.cssText = "background:none;border:0;padding:0;font:inherit;cursor:pointer;text-decoration:underline";
  link.addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions" }));
  box.appendChild(document.createElement("br"));
  box.appendChild(link);
}

if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
  chrome.extension.isAllowedFileSchemeAccess((allowed) => render(Boolean(allowed)));
} else {
  render(true);
}
