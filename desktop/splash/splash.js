// The shell navigates here with #error=<message> when the manager fails to start or crashes.
function render() {
  var match = /error=([^&]*)/.exec(location.hash);
  document.getElementById('loading').hidden = !!match;
  document.getElementById('failed').hidden = !match;
  if (match) document.getElementById('detail').textContent = decodeURIComponent(match[1]);
}
window.addEventListener('hashchange', render);
render();

