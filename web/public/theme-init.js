// Applies the saved theme before first paint to avoid a flash. Kept as a separate file
// because the server's Content-Security-Policy does not allow inline scripts.
try {
  var choice = localStorage.getItem('wtm-theme')
  var dark = choice === 'dark' || (choice !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
} catch (e) {
  /* storage unavailable: the app falls back to the system theme */
}
