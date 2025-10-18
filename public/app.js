
// MediStock front-end (clean nav + profile + maps + routing)
(() => {
  let token = null;
  let me = null;
  let autoTimer = null;
  let selectedItems = []; // {medicine_id:true}
  let map, markersLayer;
  let dispensersRows = []; // cache rows from /dispensers
  let lastUserLatLng = null;
  let routingCtl = null;

  const el = id => document.getElementById(id);
  const api = (p, opt={}) => fetch(p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token?{'Authorization':`Bearer ${token}`}:{}) }
  }).then(r => r.json());

  function ensureRouting(){
    if(!routingCtl && typeof L !== 'undefined'){
      routingCtl = L.Routing.control({
        waypoints: [],
        routeWhileDragging: false,
        addWaypoints: false,
        draggableWaypoints: false,
        show: true,
        fitSelectedRoutes: true,
        showAlternatives: false,
        lineOptions: { addWaypoints: false }
      }).addTo(map);
    }
    return routingCtl;
  }

  async function initApp(){
    try {
      initMap();
      await loadRx();
      await loadDispensers();
      await locateUser(false);
      await loadSuggestions();
      await loadHistory();
      const btnRefresh = el('btnRefresh');
      if (btnRefresh) {
        btnRefresh.onclick = async()=>{
          const r = await api('/api/prescriptions/refresh',{method:'POST'});
          renderRx(r);
        };
      }
      if(autoTimer) clearInterval(autoTimer);
      autoTimer = setInterval(()=> btnRefresh && btnRefresh.click(), 30000);
    } catch(e){
      console.error('initApp error', e);
      alert('Hubo un error inicializando la app. Revisa la consola.');
    }
  }

  async function loadRx(){
    const r = await api('/api/prescriptions');
    renderRx(r);
  }
  function renderRx(rows){
    const tblRx = el('tblRx');
    if(!tblRx) return;
    tblRx.innerHTML = '<tr><th>Rx</th><th>Medicamento</th><th>Dosificación / Frecuencia</th><th>Total</th><th>Entregadas</th><th>Pendientes</th></tr>';
    (rows||[]).forEach(x=>{
      const tr = document.createElement('tr');
      const pendBadge = `<span class="badge ${x.pending>0?'warn':'ok'}">${x.pending}</span>`;
      tr.innerHTML = `<td>${x.rx_number||'-'}</td><td>${x.name} (${x.med_code})<br>${x.form||''} ${x.strength||''}</td>
                      <td>${x.dosage||'-'} — ${x.frequency||'-'}</td>
                      <td>${x.max_units}</td><td>${x.used_units}</td><td>${pendBadge}</td>`;
      tblRx.appendChild(tr);
    });
  }

  function initMap(){
    const mapDiv = el('map');
    if(!mapDiv || typeof L === 'undefined') return;
    map = L.map('map').setView([7.119, -73.122], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);

    const btnLocate = el('btnLocate');
    if(btnLocate) btnLocate.onclick = ()=> locateUser(true);
    const btnRoute = el('btnRoute');
    if(btnRoute) btnRoute.onclick = routeSelected;
  }

  async function locateUser(pan=true){
    if(!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos=>{
      lastUserLatLng = [pos.coords.latitude, pos.coords.longitude];
      if(typeof L !== 'undefined'){
        L.circleMarker(lastUserLatLng, {radius:6}).addTo(map).bindPopup('Estás aquí');
        if(pan) map.setView(lastUserLatLng, 13);
      }
      renderSuggestions(); // resort by distance if possible
    }, ()=>{}, {enableHighAccuracy:true, timeout:3000, maximumAge:60000});
  }

  async function loadDispensers(){
    const rows = await api('/api/dispensers');
    dispensersRows = rows||[];

    // Fill selector
    const selDisp = el('selDisp');
    const inventoryDiv = el('inventory');
    if(selDisp){
      const mapSel = new Map();
      (rows||[]).forEach(r=>{ if(!mapSel.has(r.dispenser_id)) mapSel.set(r.dispenser_id, {id:r.dispenser_id, name:r.dispenser_name}); });
      selDisp.innerHTML='';
      mapSel.forEach(d=>{
        const opt = document.createElement('option');
        opt.value=d.id; opt.textContent=d.name;
        selDisp.appendChild(opt);
      });
      selDisp.onchange = ()=> renderInventory(dispensersRows.filter(x=>x.dispenser_id==selDisp.value));
      if(selDisp.options.length){
        selDisp.selectedIndex=0;
        renderInventory(dispensersRows.filter(x=>x.dispenser_id==selDisp.value));
      } else if(inventoryDiv){
        inventoryDiv.innerHTML = '<div class="muted">No hay pendientes en tus fórmulas.</div>';
      }
    }

    // Markers
    renderMarkers();
  }

  function renderMarkers(){
    if(!markersLayer || typeof L === 'undefined') return;
    markersLayer.clearLayers();
    const byDisp = {};
    (dispensersRows||[]).forEach(r=>{
      if(!byDisp[r.dispenser_id]) byDisp[r.dispenser_id] = { dispenser_id:r.dispenser_id, dispenser_name:r.dispenser_name, location:r.location, lat:r.lat, lng:r.lng, items: [] };
      byDisp[r.dispenser_id].items.push(r);
    });
    const bounds = [];
    Object.values(byDisp).forEach(d=>{
      if(!(d.lat && d.lng)) return;
      const m = L.marker([d.lat, d.lng]).addTo(markersLayer);
      const list = d.items.map(i=>`${i.med_name} (${i.med_code}) — stock ${i.stock}`).join('<br>');
      m.bindPopup(`<strong>${d.dispenser_name}</strong><br>${d.location||''}<br><br>${list}`);
      m.on('click', ()=>{
        const selDisp = el('selDisp');
        if(selDisp){
          selDisp.value = d.dispenser_id;
          renderInventory(dispensersRows.filter(x=>x.dispenser_id==d.dispenser_id));
        }
        if(lastUserLatLng){ routeToDispenser(d); }
      });
      bounds.push([d.lat, d.lng]);
    });
    if(bounds.length && map) map.fitBounds(bounds, {padding:[20,20]});
  }

  function renderInventory(rows){
    const inventoryDiv = el('inventory');
    const reserveInfo = el('reserveInfo');
    selectedItems = [];
    if(!inventoryDiv) return;
    inventoryDiv.innerHTML = '';
    (rows||[]).forEach(r=>{
      const div = document.createElement('div');
      div.className='card';
      const title = `${r.med_name} (${r.med_code}) — Stock: ${r.stock}`;
      div.innerHTML = `<div class="checkbox-row">
        <input type="checkbox" data-med="${r.medicine_id}" ${r.stock>0?'':'disabled'}/>
        <strong>${title}</strong>
        <span class="muted">${r.form||''} ${r.strength||''}</span>
      </div>`;
      inventoryDiv.appendChild(div);
    });
    inventoryDiv.querySelectorAll('input[type=checkbox]').forEach(ch=>{
      ch.onchange = ()=>{
        if(ch.checked) selectedItems.push({medicine_id: Number(ch.dataset.med)});
        else selectedItems = selectedItems.filter(x=>x.medicine_id!=Number(ch.dataset.med));
        if(reserveInfo) reserveInfo.textContent = selectedItems.length? `${selectedItems.length} seleccionado(s)` : '';
      };
    });
  }

  function routeToDispenser(disp){
    if(!disp || !disp.lat || !disp.lng){ alert('El dispensador no tiene coordenadas'); return; }
    if(!lastUserLatLng){ alert('Activa "Mi ubicación" para trazar la ruta'); return; }
    const ctl = ensureRouting();
    if(!ctl) return;
    ctl.setWaypoints([
      L.latLng(lastUserLatLng[0], lastUserLatLng[1]),
      L.latLng(disp.lat, disp.lng)
    ]);
  }

  function routeSelected(){
    const selDisp = el('selDisp');
    if(!selDisp || !selDisp.value){ alert('Selecciona un dispensador'); return; }
    const did = Number(selDisp.value);
    const one = (dispensersRows||[]).find(x=>x.dispenser_id==did);
    if(!one){ alert('No se encontró el dispensador seleccionado'); return; }
    routeToDispenser({lat:one.lat, lng:one.lng, dispenser_name: one.dispenser_name});
  }

  async function loadSuggestions(){
    const r = await api('/api/suggestions');
    window.__rawSuggestions = r; // keep raw; sorting happens on render
    renderSuggestions();
  }
  function haversine(a,b){
    const toRad = d => d*Math.PI/180;
    const [lat1,lon1] = a, [lat2,lon2] = b;
    const R=6371, dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
    const s = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }
  function renderSuggestions(){
    const suggestionsDiv = el('suggestions');
    const r = Array.isArray(window.__rawSuggestions)? [...window.__rawSuggestions] : [];
    if(lastUserLatLng){
      r.forEach(x=> x.dist = haversine(lastUserLatLng, [x.lat, x.lng]));
      r.sort((a,b)=>(a.dist||1e9)-(b.dist||1e9) || b.stock-a.stock);
    } else {
      r.sort((a,b)=> b.stock-a.stock);
    }
    if(!suggestionsDiv) return;
    if(r.length==0){ suggestionsDiv.innerHTML = '<div class="muted">Sin sugerencias.</div>'; return; }
    const g = {};
    r.forEach(x=>{ g[x.dispenser_id]=g[x.dispenser_id]||{name:x.name,lat:x.lat,lng:x.lng,items:[],dist:x.dist}; g[x.dispenser_id].items.push(x); });
    suggestionsDiv.innerHTML='';
    Object.values(g).forEach(d=>{
      const card = document.createElement('div'); card.className='card';
      const dist = (d.dist!=null)? ` — ~${(d.dist).toFixed(1)} km` : '';
      card.innerHTML = `<strong>${d.name}${dist}</strong>`;
      d.items.forEach(it=>{
        const row = document.createElement('div');
        row.textContent = `${it.med} — stock ${it.stock}`;
        card.appendChild(row);
      });
      suggestionsDiv.appendChild(card);
    });
  }

  async function loadHistory(){
    const r = await api('/api/deliveries');
    const historyDiv = el('history');
    if(!historyDiv) return;
    historyDiv.innerHTML='';
    (r||[]).forEach(x=>{
      const div = document.createElement('div'); div.className='card';
      div.textContent = `${x.delivered_at} — ${x.med} (${x.med_code}) — ${x.units} u — ${x.dispenser}`;
      historyDiv.appendChild(div);
    });
  }

  
// ---- Estado de autenticación y navegación ----
let __isAuthed = false;

function setAuthUI(auth){
  __isAuthed = !!auth;
  const btnProfile = document.getElementById('btnProfile');
  const btnHome = document.getElementById('btnHome');
  if(btnProfile) btnProfile.disabled = !__isAuthed;
  if(btnHome) btnHome.disabled = !__isAuthed;
}

function bindNavUI(){
  const appSection = document.getElementById('appSection');
  const profileSection = document.getElementById('profileSection');
  const btnProfile = document.getElementById('btnProfile');
  const btnHome = document.getElementById('btnHome');

  function showHome(){
    if(!__isAuthed) return;
    if(profileSection) profileSection.classList.add('hidden');
    if(appSection) appSection.classList.remove('hidden');
  }
  function showProfile(){
    if(!__isAuthed) return;
    if(appSection) appSection.classList.add('hidden');
    if(profileSection){ profileSection.classList.remove('hidden'); loadProfile(); }
  }

  if(btnProfile){
    btnProfile.onclick = showProfile;
  }
  if(btnHome){
    btnHome.onclick = showHome;
  }
  setAuthUI(false); // default deshabilitado hasta login
}

// ---- PERFIL ----
  function yyyymmddToAge(s){
    if(!s) return '';
    const d = new Date(s);
    if(isNaN(d)) return '';
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m===0 && now.getDate()<d.getDate())) age--;
    return age;
  }
  async function loadProfile(){
    const p = await api('/api/profile');
    const get = id => el(id);
    if(p && !p.error){
      if(get('pf_name')) get('pf_name').value = p.name||'';
      if(get('pf_cc')) get('pf_cc').value = p.cc||'';
      if(get('pf_dob')) get('pf_dob').value = (p.dob||'').slice(0,10);
      if(get('pf_age')) get('pf_age').value = yyyymmddToAge(p.dob||'')||'';
      if(get('pf_gender')) get('pf_gender').value = p.gender||'';
      if(get('pf_eps')) get('pf_eps').value = p.eps||'';
      if(get('pf_ips')) get('pf_ips').value = p.ips||'';
      if(get('pf_email')) get('pf_email').value = p.email||'';
      if(get('pf_phone')) get('pf_phone').value = p.phone||'';
      if(get('pf_city')) get('pf_city').value = p.city||'';
      if(get('pf_address')) get('pf_address').value = p.address||'';
      if(get('pf_blood')) get('pf_blood').value = p.blood_type||'';
      if(get('pf_econtact')) get('pf_econtact').value = p.emergency_contact||'';
      if(get('pf_ephone')) get('pf_ephone').value = p.emergency_phone||'';
    } else {
      const pfMsg = el('pfMsg');
      if(pfMsg) pfMsg.textContent = (p && p.error) || 'No se pudo cargar el perfil';
    }
  }

  function bindProfileUI(){
    const pf_dob = el('pf_dob');
    if(pf_dob){
      pf_dob.addEventListener('change', (e)=>{
        const pf_age = el('pf_age');
        if(pf_age) pf_age.value = yyyymmddToAge(e.target.value)||'';
      });
    }
    const btnSaveProfile = el('btnSaveProfile');
    if(btnSaveProfile){
      btnSaveProfile.onclick = async()=>{
        const pfMsg = el('pfMsg');
        const body = {
          name: (el('pf_name')?.value||'').trim(),
          cc: (el('pf_cc')?.value||'').trim(),
          dob: el('pf_dob')?.value||null,
          gender: el('pf_gender')?.value||null,
          eps: (el('pf_eps')?.value||'').trim(),
          ips: (el('pf_ips')?.value||'').trim(),
          email: (el('pf_email')?.value||'').trim(),
          phone: (el('pf_phone')?.value||'').trim(),
          city: (el('pf_city')?.value||'').trim(),
          address: (el('pf_address')?.value||'').trim(),
          blood_type: (el('pf_blood')?.value||'').trim(),
          emergency_contact: (el('pf_econtact')?.value||'').trim(),
          emergency_phone: (el('pf_ephone')?.value||'').trim(),
        };
        const r = await api('/api/profile', {method:'PUT', body: JSON.stringify(body)});
        if(pfMsg) pfMsg.textContent = r.error ? r.error : 'Perfil guardado ✅';
      };
    }
    const btnChangePass = el('btnChangePass');
    if(btnChangePass){
      btnChangePass.onclick = async()=>{
        const oldp = el('pf_oldpass')?.value;
        const newp = el('pf_newpass')?.value;
        const pfPassMsg = el('pfPassMsg');
        if(!(oldp && newp)){ if(pfPassMsg) pfPassMsg.textContent = 'Completa las contraseñas'; return; }
        const r = await api('/api/profile/password', {method:'PUT', body: JSON.stringify({old_password:oldp, new_password:newp})});
        if(pfPassMsg) pfPassMsg.textContent = r.ok ? 'Contraseña actualizada ✅' : (r.error||'Error');
        if(r.ok){ if(el('pf_oldpass')) el('pf_oldpass').value=''; if(el('pf_newpass')) el('pf_newpass').value=''; }
      };
    }
  }

  function bindGlobalUI(){
    const authSection = el('authSection');
    const appSection = el('appSection');
    const profileSection = el('profileSection');

    const btnLogin = el('btnLogin');
    if(btnLogin){
      btnLogin.onclick = async()=>{
        const email = el('email')?.value?.trim();
        const password = el('password')?.value;
        const r = await api('/api/login',{method:'POST',body:JSON.stringify({email,password})});
        const authMsg = el('authMsg');
        if(r.token){
          token=r.token; me=r.user;
          if(authSection) authSection.classList.add('hidden');
          if(profileSection) profileSection.classList.add('hidden');
          if(appSection) appSection.classList.remove('hidden');
          setAuthUI(true);
          initApp();
        } else{
          if(authMsg) authMsg.textContent = 'Error de autenticación: ' + (r.error || 'Intente de nuevo');
        }
      };
    }

    const btnLogout = el('btnLogout');
    if(btnLogout){
      btnLogout.onclick = ()=>{
        if(confirm('¿Deseas salir del aplicativo?')){
          token=null; me=null; selectedItems=[];
          if(autoTimer) clearInterval(autoTimer);
          if(profileSection) profileSection.classList.add('hidden');
          if(appSection) appSection.classList.add('hidden');
          if(authSection) authSection.classList.remove('hidden');
          setAuthUI(false);
        }
      };
    }

    const btnReserve = el('btnReserve');
    if(btnReserve){
      btnReserve.onclick = async()=>{
        const selDisp = el('selDisp');
        const reserveInfo = el('reserveInfo');
        const d = Number(selDisp?.value);
        if(!d || !selectedItems.length){ alert('Selecciona un dispensador y al menos un medicamento'); return; }
        const r = await api('/api/reservations',{method:'POST',body:JSON.stringify({dispenser_id:d, items:selectedItems})});
        if(r.error){ alert(r.error); return; }
        const { code, expires } = r;
        if(reserveInfo) reserveInfo.innerHTML = `Código de retiro: <strong>${code}</strong> (vence ${expires}) 
          — <a href="/api/reservations/${code}/pdf" target="_blank">PDF</a> — <img src="/api/reservations/${code}/qr" alt="qr" height="64">`;
        await loadRx(); await loadHistory();
      };
    }

    const btnPickup = el('btnPickup');
    if(btnPickup){
      btnPickup.onclick = async()=>{
        const code = el('pickupCode')?.value?.trim();
        const pickupMsg = el('pickupMsg');
        if(!code){ alert('Ingresa el código'); return; }
        const r = await api('/api/pickup',{method:'POST',body:JSON.stringify({code})});
        if(pickupMsg) pickupMsg.textContent = r.ok ? 'Entrega confirmada ✅' : (r.error||'Error');
        await loadRx(); await loadHistory();
      };
    }

    // Nav: Perfil / Inicio
    const btnProfile = el('btnProfile');
    const btnHome = el('btnHome');
    if(btnProfile){
      btnProfile.onclick = ()=>{
        if(appSection) appSection.classList.add('hidden');
        if(profileSection){ profileSection.classList.remove('hidden'); loadProfile(); }
      };
    }
    if(btnHome){
      btnHome.onclick = ()=>{
        if(profileSection) profileSection.classList.add('hidden');
        if(appSection) appSection.classList.remove('hidden');
      };
    }

    
// ---- Perfil: edición controlada ----
function setProfileEditable(edit){
  // Campos siempre bloqueados
  const alwaysLocked = ['pf_cc','pf_dob','pf_age'];
  const maybe = ['pf_name','pf_gender','pf_eps','pf_ips','pf_email','pf_phone','pf_city','pf_address','pf_blood','pf_econtact','pf_ephone'];
  for(const id of alwaysLocked){
    const e = document.getElementById(id); if(e) e.disabled = true;
  }
  for(const id of maybe){
    const e = document.getElementById(id); if(e) e.disabled = !edit;
  }
  const btnEdit = document.getElementById('btnEditProfile');
  const btnSave = document.getElementById('btnSaveProfile');
  if(btnEdit) btnEdit.disabled = !__isAuthed;
  if(btnSave) btnSave.disabled = !__isAuthed; // se puede guardar solo estando logeado
}

function bindProfileEditUI(){
  const btnEdit = document.getElementById('btnEditProfile');
  const btnSave = document.getElementById('btnSaveProfile');
  setProfileEditable(false); // por defecto bloqueado
  if(btnEdit){
    btnEdit.onclick = ()=>{
      if(!__isAuthed) return;
      setProfileEditable(true);
    };
  }
  if(btnSave){
    const origHandler = btnSave.onclick; // puede haber uno existente
    btnSave.onclick = async ()=>{
      if(!__isAuthed) return;
      if(origHandler){ await origHandler(); }
      setProfileEditable(false); // bloquear nuevamente después de guardar
    };
  }
}

// Perfil field bindings
    bindProfileUI();
  }

  document.addEventListener('DOMContentLoaded', ()=>{ bindGlobalUI(); bindNavUI(); bindProfileEditUI(); });
})();

/* ===== Perfil: controlador de edición (parche mínimo, no invasivo) ===== */
(function(){
  // Detecta sesión sin depender del nombre exacto de tu flag
  function isAuthed(){
    if (typeof __isAuthed !== 'undefined') return !!__isAuthed;
    if (typeof isAuthed !== 'undefined') return !!isAuthed;
    return !!window.token; // fallback
  }

  // Bloquea/desbloquea campos del perfil
  function setProfileEditable(edit){
    // SIEMPRE BLOQUEADOS (no editables)
    const lock = ['pf_name','pf_cc','pf_dob','pf_age','pf_gender','pf_eps','pf_ips','pf_blood'];
    // EDITABLES EN MODO EDICIÓN
    const editable = ['pf_email','pf_phone','pf_city','pf_address','pf_econtact','pf_ephone'];

    lock.forEach(id => { const e = document.getElementById(id); if(e) e.disabled = true; });
    editable.forEach(id => { const e = document.getElementById(id); if(e) e.disabled = !edit; });

    const bEdit = document.getElementById('btnEditProfile');
    const bSave = document.getElementById('btnSaveProfile');
    if (bEdit) bEdit.disabled = !isAuthed();
    if (bSave) bSave.disabled = !isAuthed();
  }

  // Guarda solo los campos editables; no toca los bloqueados
  async function saveProfileEditableFields(){
    const body = {
      email: (document.getElementById('pf_email')?.value||'').trim(),
      phone: (document.getElementById('pf_phone')?.value||'').trim(),
      city: (document.getElementById('pf_city')?.value||'').trim(),
      address: (document.getElementById('pf_address')?.value||'').trim(),
      blood_type: (document.getElementById('pf_blood')?.value||'').trim(),
      emergency_contact: (document.getElementById('pf_econtact')?.value||'').trim(),
      emergency_phone: (document.getElementById('pf_ephone')?.value||'').trim(),
      // Si tu backend permite actualizar nombre/género/EPS/IPS y quieres mantenerlos bloqueados visualmente,
      // puedes incluirlos aquí; si no, déjalos fuera para no tocarlos.
    };
    const pfMsg = document.getElementById('pfMsg');
    try{
      const r = await api('/api/profile', { method:'PUT', body: JSON.stringify(body) });
      if (pfMsg) pfMsg.textContent = (r && !r.error) ? 'Perfil guardado ✅' : (r?.error || 'Error al guardar');
    } catch(e){
      if (pfMsg) pfMsg.textContent = 'Error de red guardando el perfil';
    }
  }

  // Enlaza Editar/Guardar una sola vez, sin romper handlers previos
  function wireProfileEditIfNeeded(){
    const bEdit = document.getElementById('btnEditProfile');
    const bSave = document.getElementById('btnSaveProfile');
    if (!bEdit || !bSave) return;

    // Estado inicial: bloqueado
    setProfileEditable(false);

    if (!bEdit.dataset.bound){
      bEdit.addEventListener('click', () => {
        if (!isAuthed()) return;
        setProfileEditable(true);
      });
      bEdit.dataset.bound = '1';
    }

    if (!bSave.dataset.bound){
      const prev = bSave.onclick; // preserva cualquier guardado existente
      bSave.addEventListener('click', async () => {
        if (!isAuthed()) return;
        if (typeof prev === 'function') {
          const maybePromise = prev();
          if (maybePromise && typeof maybePromise.then === 'function') await maybePromise;
        } else {
          await saveProfileEditableFields();
        }
        // Re-bloquea y refresca datos
        setProfileEditable(false);
        if (typeof loadProfile === 'function') await loadProfile();
      });
      bSave.dataset.bound = '1';
    }
  }

  // Intenta cablear al cargar y cuando se navega a Perfil
  document.addEventListener('DOMContentLoaded', () => {
    try { wireProfileEditIfNeeded(); } catch(e){}
  });

  // Si tu app tiene una función showProfile(), la envolvemos sin cambiar su comportamiento
  const _sp = typeof window.showProfile === 'function' ? window.showProfile : null;
  window.showProfile = function(){
    if (_sp) _sp.apply(this, arguments);
    // Tras mostrar la sección, asegura estado bloqueado y botones cableados
    try { setProfileEditable(false); wireProfileEditIfNeeded(); } catch(e){}
  };
})();

