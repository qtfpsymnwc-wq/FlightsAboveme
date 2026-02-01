window.FW_APP_LOADED = "v46";
try{
  var st = document.getElementById('fw-status');
  if (st) st.innerText = 'App loaded v46…';
  var v = document.getElementById('fw-version');
  if (v) v.textContent = 'v46';
}catch(e){}

// Chain-load the real app (v45) after marker proves execution
(function(){
  var s = document.createElement('script');
  s.src = 'app-v45.js?ts=' + Date.now();
  s.onload = function(){
    var st = document.getElementById('fw-status');
    if (st) st.innerText = 'Loaded core app (v45)…';
  };
  s.onerror = function(){
    var st = document.getElementById('fw-status');
    if (st) st.innerText = 'ERROR: core app script failed to load';
  };
  document.body.appendChild(s);
})();
