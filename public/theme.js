try {
  var t = localStorage.getItem('numero:theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) { /* storage unavailable: follow the system theme */ }
