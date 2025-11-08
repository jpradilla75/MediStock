// MediStock front-end (clean nav + profile + maps + routing)
(() => {
  let token = null;
  let me = null;
  let autoTimer = null;
  let map, markersLayer;
  let dispensersRows = []; // cache rows from /dispensers
  let lastUserLatLng = null;
  let routingCtl = null;
  
  // Variable global para medicamentos pendientes del usuario (usada en renderInventory)
  // Key: med_code, Value: {name, strength, form, pending_units, medicine_id}
  let userPendingMeds = new Map(); 

  const el = id => document.getElementById(id);
  const api = (p, opt={}) => fetch(p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token?{'Authorization':`Bearer ${token}`}:{}) }
  }).then(r => r.json());

// Agrega esto al inicio de tu app.js, después de las declaraciones de variables
function initResponsiveFeatures() {
  // Detectar si es móvil
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  
  if (isMobile) {
    console.log('Dispositivo móvil detectado, aplicando optimizaciones...');
    document.body.classList.add('mobile-device');
    
    // Optimizar mapa para móviles
    if (map) {
      map.dragging.enable();
      map.touchZoom.enable();
      map.doubleClickZoom.enable();
      map.scrollWheelZoom.enable();
    }
  } else {
    document.body.classList.add('desktop-device');
  }
}

// Llamar esta función en DOMContentLoaded
document.addEventListener('DOMContentLoaded', ()=>{ 
  bindGlobalUI(); 
  bindNavUI(); 
  bindProfileEditUI(); 
  bindProfileUI();
  initDispenserUI();
  initResponsiveFeatures(); // <-- Agrega esta línea
});

  
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
      console.log('Inicializando aplicación...');
      
      // Primero cargar los datos básicos del usuario
      const userData = await api('/api/me');
      console.log('Datos usuario:', userData);
      
      initMap();
      await loadRx();
      await loadDispensers();
      await locateUser(false);
      await loadSuggestions();
      await loadHistory();
      
      const btnRefresh = el('btnRefresh');
      if (btnRefresh) {
        btnRefresh.onclick = async()=>{
          try {
            const r = await api('/api/prescriptions/refresh',{method:'POST'});
            renderRx(r);
            await loadDispensers();
            await loadSuggestions();
          } catch(e) {
            console.error('Error en refresh:', e);
          }
        };
      }
      
      if(autoTimer) clearInterval(autoTimer);
      autoTimer = setInterval(()=> btnRefresh && btnRefresh.click(), 30000);
      
      console.log('Aplicación inicializada correctamente');
      
    } catch(e){
      console.error('initApp error completo:', e);
      alert('Hubo un error inicializando la app: ' + (e.message || 'Error desconocido. Revisa la consola.'));
    }
  }

  async function loadRx(){
    const r = await api('/api/prescriptions');
    renderRx(r);
  }
  
  function renderRx(rows){
    const tblRx = el('tblRx');
    if(!tblRx) return;
    
    const combinedRows = rows || [];
    
    // 1. GUARDAR PENDIENTES Y AGRUPAR DATOS (Desduplicación)
    const groupedRows = {};
    userPendingMeds.clear(); // Limpia la lista de pendientes
    
    (combinedRows||[]).forEach(x=>{
      const key = x.med_code || `no_code_${x.name}`; 
      
      if(!groupedRows[key]){
        groupedRows[key] = {
          rx_number: x.rx_number || '-',
          name: x.name,
          med_code: x.med_code,
          form: x.form,
          strength: x.strength,
          dosage: x.dosage || '-',
          frequency: x.frequency || '-',
          max_units: 0,
          used_units: 0,
          pending: 0,
          medicine_id: x.medicine_id 
        };
      }
      groupedRows[key].max_units += (x.max_units || 0);
      groupedRows[key].used_units += (x.used_units || 0);
      groupedRows[key].pending += (x.pending || 0);
      
      // Guarda en el mapa si hay pendientes (Añadiendo pending_units)
      if(groupedRows[key].pending > 0){
          userPendingMeds.set(key, { 
              name: groupedRows[key].name, 
              strength: groupedRows[key].strength, 
              form: groupedRows[key].form,
              pending_units: groupedRows[key].pending, 
              medicine_id: groupedRows[key].medicine_id 
          });
      }
    });

    // 2. Limpia la tabla y añade el encabezado
    tblRx.innerHTML = '<tr><th>Rx</th><th>Medicamento</th><th>Dosificación / Frecuencia</th><th>Total</th><th>Entregadas</th><th>Pendientes</th></tr>';
    
    // 3. Renderiza las filas agrupadas
    Object.values(groupedRows).forEach(x=>{
      const tr = document.createElement('tr');
      const pendBadge = `<span class="badge ${x.pending>0?'warn':'ok'}">${x.pending}</span>`;
      
      tr.innerHTML = `<td>${x.rx_number}</td>
                      <td>${x.name} (${x.med_code})<br>${x.form||''} ${x.strength||''}</td>
                      <td>${x.dosage} — ${x.frequency}</td>
                      <td>${x.max_units}</td><td>${x.used_units}</td><td>${pendBadge}</td>`;
      tblRx.appendChild(tr);
    });
  }

  function initMap(){
    const mapDiv = el('map');
    if(!mapDiv || typeof L === 'undefined') return;
    
    // VERIFICAR si el mapa ya está inicializado
    if (map) {
      console.log('Mapa ya inicializado, omitiendo nueva inicialización');
      return;
    }
    
    // Limpiar cualquier mapa existente en el contenedor
    if (mapDiv._leaflet_id) {
      mapDiv._leaflet_id = null;
      mapDiv.innerHTML = '';
    }
    
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
    
    // El stock es real (viene de la base de datos).
    dispensersRows = rows || [];
    
    // Fill selector: Solución a la repetición del dispensador
    const selDisp = el('selDisp');
    const inventoryDiv = el('inventory');
    if(selDisp){
      const mapSel = new Map();
      // Usar un mapa para guardar solo una entrada por dispenser_id
      (dispensersRows||[]).forEach(r=>{ 
          if(!mapSel.has(r.dispenser_id)) mapSel.set(r.dispenser_id, {id:r.dispenser_id, name:r.dispenser_name}); 
      });
      
      selDisp.innerHTML='';
      mapSel.forEach(d=>{
        const opt = document.createElement('option');
        opt.value=d.id; opt.textContent=d.name;
        selDisp.appendChild(opt);
      });
      
      // Filtra y renderiza solo los ítems del dispensador seleccionado
      selDisp.onchange = ()=> renderInventory(dispensersRows.filter(x=>x.dispenser_id==selDisp.value));
      
      if(selDisp.options.length){
        selDisp.selectedIndex=0;
        renderInventory(dispensersRows.filter(x=>x.dispenser_id==selDisp.value));
      } else if(inventoryDiv){
        inventoryDiv.innerHTML = '<div class="muted">No hay dispensadores disponibles.</div>';
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

  // FUNCIÓN DE INVENTARIO: Muestra solo los medicamentos pendientes y asigna unidades automáticamente
  function renderInventory(dispenserRows){
    const inventoryDiv = el('inventory');
    const reserveInfo = el('reserveInfo');
    
    // 1. Filtrar los rows del dispensador para solo incluir los medicamentos pendientes del usuario
    const pendingInventory = dispenserRows.filter(r => userPendingMeds.has(r.med_code));

    inventoryDiv.innerHTML = '';
    
    if(userPendingMeds.size === 0){
        inventoryDiv.innerHTML = '<div class="muted">No tienes medicamentos pendientes en tus fórmulas.</div>';
        return;
    }
    if(pendingInventory.length === 0){
        inventoryDiv.innerHTML = '<div class="muted">El dispensador seleccionado no tiene ninguno de tus medicamentos pendientes.</div>';
        return;
    }

    // 2. Renderizar solo los medicamentos filtrados
    pendingInventory.forEach(r=>{
      const div = document.createElement('div');
      div.className='card';
      
      const stock = r.stock || 0; 
      const availableStatus = stock > 0 ? 'Disponible' : 'No disponible';
      const availableClass = stock > 0 ? 'ok' : 'warn';
      const pendingUnits = userPendingMeds.get(r.med_code).pending_units;
      
      // LÓGICA CLAVE: Cantidad máxima a reservar
      const unitsToReserve = Math.min(stock, pendingUnits);
      
      const title = `${r.med_name} (${r.med_code}) — Stock: ${stock}u (${availableStatus}) - Pendiente: ${pendingUnits}u`;
      
      // Determinar si es reservable: debe haber stock y unidades pendientes
      const isReservable = unitsToReserve > 0;
      const reserveText = isReservable ? `Cantidad a reservar: ${unitsToReserve}u` : availableStatus;
      
      // Se añade data-units con la cantidad CALCULADA
      div.innerHTML = `<div class="checkbox-row">
        <input type="checkbox" id="chk_med_${r.medicine_id}" data-med="${r.medicine_id}" data-code="${r.med_code}" 
               data-units="${unitsToReserve}" ${isReservable ? '' : 'disabled'}/>
        <label for="chk_med_${r.medicine_id}">
            <strong>${title}</strong>
            <span class="badge ${availableClass}" style="margin-left: 10px;">${reserveText}</span>
        </label>
        <span class="muted">${r.form||''} ${r.strength||''}</span>
      </div>`;
      inventoryDiv.appendChild(div);
    });
    
    // 3. Enlazar el manejo de selección de ítems (solo checkbox, para el conteo visual)
    inventoryDiv.querySelectorAll('input[type=checkbox]').forEach(ch=>{
      ch.onchange = ()=>{
        // SÓLO ACTUALIZA EL CONTEO VISUAL
        const selectedCount = inventoryDiv.querySelectorAll('input[type=checkbox]:checked').length;
        if(reserveInfo) reserveInfo.textContent = selectedCount? `${selectedCount} seleccionado(s)` : '';
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
      div.textContent = `${x.delivered_at.slice(0,10)} — ${x.med} (${x.med_code}) — ${x.units} u — ${x.dispenser}`;
      historyDiv.appendChild(div);
    });
  }

  // ---- Estado de autenticación y navegación ----
  let __isAuthed = false;

  function setAuthUI(auth){
    __isAuthed = !!auth;
    const btnProfile = document.getElementById('btnProfile');
    const btnHome = document.getElementById('btnHome');
    const btnLogin = document.getElementById('btnLogin');
    const btnLogout = document.getElementById('btnLogout');
    const btnDispenserMode = document.getElementById('btnDispenserMode');
    
    console.log('setAuthUI llamado con:', auth, 'isAuthed:', __isAuthed);
    
    // Botones de navegación (Perfil/Inicio) - SOLO cuando está autenticado
    if(btnProfile) {
      btnProfile.style.display = __isAuthed ? 'inline-block' : 'none';
      btnProfile.disabled = !__isAuthed;
    }
    if(btnHome) {
      btnHome.style.display = __isAuthed ? 'inline-block' : 'none';
      btnHome.disabled = !__isAuthed;
    }
    if(btnDispenserMode) {
      btnDispenserMode.style.display = __isAuthed ? 'inline-block' : 'none';
      btnDispenserMode.disabled = !__isAuthed;
    }

    // Botones de sesión (Ingresar/Salir)
    if(btnLogin) {
      btnLogin.disabled = __isAuthed;
      btnLogin.style.display = __isAuthed ? 'none' : 'inline-block';
    }
    if(btnLogout) {
      btnLogout.disabled = !__isAuthed;
      btnLogout.style.display = __isAuthed ? 'inline-block' : 'none';
    }
  }

  function bindNavUI(){
    const appSection = el('appSection');
    const profileSection = el('profileSection');
    const authSection = el('authSection');
    const btnProfile = el('btnProfile');
    const btnHome = el('btnHome');

    function showHome(){
      if(!__isAuthed) return;
      if(authSection) authSection.classList.add('hidden');
      if(profileSection) profileSection.classList.add('hidden');
      if(appSection) appSection.classList.remove('hidden');
    }
    
    function showProfile(){
      if(!__isAuthed) return;
      if(authSection) authSection.classList.add('hidden');
      if(appSection) appSection.classList.add('hidden');
      if(profileSection){ 
        profileSection.classList.remove('hidden'); 
        loadProfile(); 
      }
    }

    if(btnProfile){
      btnProfile.onclick = showProfile;
    }
    if(btnHome){
      btnHome.onclick = showHome;
    }
    
    // Estado inicial
    setAuthUI(false);
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
    try {
      const p = await api('/api/me');
      const get = id => el(id);
      
      if(p && !p.error){
        console.log('Datos del perfil cargados:', p);
        
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
        
        const pfMsg = el('pfMsg');
        if(pfMsg) pfMsg.textContent = 'Perfil cargado correctamente';
      } else {
        const pfMsg = el('pfMsg');
        if(pfMsg) pfMsg.textContent = (p && p.error) || 'No se pudo cargar el perfil';
        console.error('Error cargando perfil:', p);
      }
    } catch(error) {
      console.error('Error en loadProfile:', error);
      const pfMsg = el('pfMsg');
      if(pfMsg) pfMsg.textContent = 'Error cargando perfil: ' + error.message;
    }
  }

  function setProfileEditable(edit){
    // Campos que SI deben ser editables
    const editableFields = [
      'pf_name', 'pf_gender', 'pf_eps', 'pf_ips', 'pf_email', 
      'pf_phone', 'pf_city', 'pf_address', 'pf_blood', 
      'pf_econtact', 'pf_ephone'
    ];
    
    // Campos que NO deben ser editables (siempre bloqueados)
    const lockedFields = ['pf_cc', 'pf_dob', 'pf_age'];
    
    // Activar/desactivar campos editables
    for(const id of editableFields){
      const e = document.getElementById(id); 
      if(e) e.disabled = !edit;
    }
    
    // Asegurar que campos bloqueados siempre estén deshabilitados
    for(const id of lockedFields){
      const e = document.getElementById(id); 
      if(e) e.disabled = true;
    }
    
    // Controlar visibilidad de botones
    const btnEdit = document.getElementById('btnEditProfile');
    const btnSave = document.getElementById('btnSaveProfile');
    
    if(btnEdit) btnEdit.style.display = edit ? 'none' : 'block';
    if(btnSave) btnSave.style.display = edit ? 'block' : 'none';
    
    // Mensaje de estado
    const pfMsg = document.getElementById('pfMsg');
    if(pfMsg) {
      pfMsg.textContent = edit ? 'Modo edición activado' : '';
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
        
        // Validaciones
        if(!body.name || !body.email) {
          pfMsg.textContent = 'Error: Nombre y correo son obligatorios';
          return;
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if(!emailRegex.test(body.email)) {
          pfMsg.textContent = 'Error: Formato de correo electrónico inválido';
          return;
        }
        
        pfMsg.textContent = 'Guardando...';
        
        const r = await api('/api/profile', {method:'PUT', body: JSON.stringify(body)});
        
        if(r.error) {
          pfMsg.textContent = 'Error: ' + r.error;
        } else {
          pfMsg.textContent = 'Perfil guardado ✅';
          setProfileEditable(false);
        }
      };
    }
    
    // CORRECCIÓN: Añadir el event handler para el botón de cambiar contraseña
    const btnChangePass = el('btnChangePass');
    if(btnChangePass){
      // Limpiar eventos anteriores
      const newBtnChangePass = btnChangePass.cloneNode(true);
      btnChangePass.parentNode.replaceChild(newBtnChangePass, btnChangePass);
      
      // Asignar nuevo evento al botón de cambiar contraseña
      document.getElementById('btnChangePass').onclick = async function() {
        const oldp = el('pf_oldpass')?.value;
        const newp = el('pf_newpass')?.value;
        const pfPassMsg = el('pfPassMsg');
        
        if(!oldp || !newp) {
          if(pfPassMsg) pfPassMsg.textContent = 'Error: Completa ambos campos de contraseña';
          return;
        }
        
        if(newp.length < 4) {
          if(pfPassMsg) pfPassMsg.textContent = 'Error: La nueva contraseña debe tener al menos 4 caracteres';
          return;
        }
        
        try {
          // Deshabilitar botón durante la solicitud
          this.disabled = true;
          pfPassMsg.textContent = 'Cambiando contraseña...';
          
          const r = await api('/api/profile/password', {
            method:'PUT', 
            body: JSON.stringify({
              old_password: oldp, 
              new_password: newp
            })
          });
          
          if(r.ok) {
            pfPassMsg.textContent = '✅ Contraseña actualizada correctamente';
            // Limpiar campos
            if(el('pf_oldpass')) el('pf_oldpass').value = '';
            if(el('pf_newpass')) el('pf_newpass').value = '';
          } else {
            pfPassMsg.textContent = '❌ Error: ' + (r.error || 'No se pudo cambiar la contraseña');
          }
        } catch(error) {
          console.error('Error cambiando contraseña:', error);
          pfPassMsg.textContent = '❌ Error de conexión al cambiar contraseña';
        } finally {
          // Re-habilitar botón
          this.disabled = false;
        }
      };
    }
  }

  function bindProfileEditUI(){
    const btnEdit = document.getElementById('btnEditProfile');
    const btnSave = document.getElementById('btnSaveProfile');
    
    // Estado inicial: solo botón editar visible
    setProfileEditable(false);
    
    if(btnEdit){
      btnEdit.onclick = ()=>{
        if(!__isAuthed) {
          alert('Debes estar autenticado para editar el perfil');
          return;
        }
        setProfileEditable(true);
        
        // Enfocar el primer campo editable
        const firstField = el('pf_name');
        if(firstField) firstField.focus();
      };
    }
    
    if(btnSave){
      btnSave.onclick = async ()=>{
        if(!__isAuthed) return;
        
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
        
        // Validaciones
        if(!body.name || !body.email) {
          pfMsg.textContent = 'Error: Nombre y correo son obligatorios';
          return;
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if(!emailRegex.test(body.email)) {
          pfMsg.textContent = 'Error: Formato de correo electrónico inválido';
          return;
        }
        
        pfMsg.textContent = 'Guardando...';
        
        const r = await api('/api/profile', {method:'PUT', body: JSON.stringify(body)});
        
        if(r.error) {
          pfMsg.textContent = 'Error: ' + r.error;
        } else {
          pfMsg.textContent = 'Perfil guardado ✅';
          setProfileEditable(false);
        }
      };
    }
  }

  function bindGlobalUI(){
    const authSection = el('authSection');
    const appSection = el('appSection');
    const profileSection = el('profileSection');

    // BOTÓN INGRESAR - Versión simplificada y robusta
    const btnLogin = el('btnLogin');
    if(btnLogin){
      // Limpiar eventos anteriores
      const newLogin = btnLogin.cloneNode(true);
      btnLogin.parentNode.replaceChild(newLogin, btnLogin);
      
      // Asignar nuevo evento
      document.getElementById('btnLogin').onclick = async function() {
        console.log('Botón Ingresar clickeado');
        
        // Si ya está autenticado, no hacer nada
        if(__isAuthed) {
          console.log('Ya autenticado, ignorando click');
          return;
        }
        
        const email = el('email')?.value?.trim();
        const password = el('password')?.value;
        const authMsg = el('authMsg');
        
        if(!email || !password) {
          authMsg.textContent = 'Por favor completa email y contraseña';
          return;
        }
        
        try {
          // Deshabilitar botón durante el login
          this.disabled = true;
          authMsg.textContent = 'Iniciando sesión...';
          
          const r = await api('/api/login',{
            method:'POST',
            body:JSON.stringify({email,password})
          });
          
          if(r.token){
            token = r.token; 
            me = r.user;
            console.log('Login exitoso');
            
            // Ocultar/mostrar secciones
            if(authSection) authSection.classList.add('hidden');
            if(profileSection) profileSection.classList.add('hidden');
            if(appSection) appSection.classList.remove('hidden');
            
            // Actualizar UI de autenticación
            setAuthUI(true);
            
            // Inicializar aplicación
            await initApp();
            
            authMsg.textContent = '';
          } else {
            authMsg.textContent = 'Error: ' + (r.error || 'Credenciales incorrectas');
            // Re-habilitar botón en caso de error
            this.disabled = false;
          }
        } catch(error) {
          console.error('Error en login:', error);
          authMsg.textContent = 'Error de conexión. Intenta nuevamente.';
          // Re-habilitar botón en caso de error
          this.disabled = false;
        }
      };
    }

    // BOTÓN SALIR
    const btnLogout = el('btnLogout');
    if(btnLogout){
      // Limpiar eventos anteriores
      const newLogout = btnLogout.cloneNode(true);
      btnLogout.parentNode.replaceChild(newLogout, btnLogout);
      
      // Asignar nuevo evento
      document.getElementById('btnLogout').onclick = function() {
        // Si no está autenticado, no hacer nada
        if(!__isAuthed) {
          console.log('No autenticado, ignorando click de salir');
          return;
        }
        
        if(confirm('¿Deseas salir del aplicativo?')){
          console.log('Cerrando sesión...');
          token = null; 
          me = null; 
          
          // Detener timer de actualización automática
          if(autoTimer) {
            clearInterval(autoTimer);
            autoTimer = null;
          }
          
          // DESTRUIR EL MAPA ANTES DE CERRAR SESIÓN
          if (map) {
            map.remove();
            map = null;
            markersLayer = null;
            routingCtl = null;
            console.log('Mapa destruido');
          }
          
          // Ocultar/mostrar secciones
          if(profileSection) profileSection.classList.add('hidden');
          if(appSection) appSection.classList.add('hidden');
          if(authSection) authSection.classList.remove('hidden');
          
          // Actualizar UI de autenticación
          setAuthUI(false);
          
          // Limpiar mensajes
          const authMsg = el('authMsg');
          if(authMsg) authMsg.textContent = '';
          
          // Restablecer campos de login
          if(el('email')) el('email').value = 'ana@medistock.local';
          if(el('password')) el('password').value = 'ana12345';
          
          console.log('Sesión cerrada exitosamente');
        }
      };
    }

    const btnReserve = el('btnReserve');
    if(btnReserve){
      // Aplicar clase especial para hacerlo más visible
      btnReserve.className = 'btn reserve-highlight';
      btnReserve.onclick = async()=>{
        const selDisp = el('selDisp');
        const reserveInfo = el('reserveInfo');
        const d = Number(selDisp?.value);
        
        // 1. RECOLECCIÓN ROBUSTA DE DATOS DESDE EL DOM
        const inventoryEl = el('inventory');
        
        if (!inventoryEl) {
             alert('No se encontró el inventario.'); 
             return;
        }

        // Obtener solo los checkboxes marcados y extraer sus unidades CALCULADAS automáticamente
        const itemsToReserve = Array.from(inventoryEl.querySelectorAll('input[type=checkbox]:checked'))
            .map(ch => {
                // Asegurar que los datos se lean como enteros
                const medId = parseInt(ch.dataset.med, 10);
                const units = parseInt(ch.dataset.units, 10); 
                
                return { 
                    medicine_id: medId, 
                    units: units 
                };
            })
            // FILTRADO ESTRICTO: Solo enviar items con unidades > 0
            .filter(item => item.units > 0); 
        
        // 2. Validación final de unidades
        if(!d || itemsToReserve.length === 0){ 
          alert('Selecciona un dispensador y al menos un medicamento con unidades disponibles para reservar.'); 
          return; 
        }
        
        // 3. AISLAR Y CONSTRUIR EL PAYLOAD
        const payload = {
            dispenser_id: d, 
            // Mapear solo al formato que la API espera: [{ medicine_id, units }]
            items: itemsToReserve
        };

        // 4. Llamada a la API
        const r = await api('/api/reservations',{
            method:'POST',
            body:JSON.stringify(payload)
        });

        if(r.error){ 
          alert(`Error de Reserva: ${r.error}`); 
          return; 
        }
        
        // 5. Recargar la UI para reflejar los cambios de STOCK, FÓRMULAS y SUGERENCIAS
        if(r.code){
            const { code, expires } = r;
            if(reserveInfo) reserveInfo.innerHTML = `Código de retiro: <strong>${code}</strong> (vence ${expires}) 
            — <a href="/api/reservations/${code}/pdf" target="_blank">PDF</a> — <img src="/api/reservations/${code}/qr" alt="qr" height="64">`;
            
            await loadRx(); // Recargar Mis Fórmulas
            await loadDispensers(); // Recargar stock real y re-renderizar inventario
            await loadSuggestions(); // Recargar Sugerencias
            await loadHistory(); // Recargar Historial
            
        } else {
             alert('Reserva fallida: El servidor no devolvió un código.');
        }
      };
    }

    // BOTÓN MODO DISPENSADOR
    const btnDispenserMode = el('btnDispenserMode');
    if(btnDispenserMode){
      btnDispenserMode.onclick = showDispenserMode;
    }

    // Inicialización
    setAuthUI(false);
  }

  // ---- DISPENSADOR FÍSICO MEJORADO ----
  function showDispenserMode(){
    if(!__isAuthed) {
      alert('Debes iniciar sesión para acceder al modo dispensador');
      return;
    }
    
    // Ocultar todas las secciones y mostrar solo el dispensador
    const allSections = document.querySelectorAll('section');
    allSections.forEach(section => section.classList.add('hidden'));
    el('dispenserSection').classList.remove('hidden');
    
    // Reiniciar el dispensador
    resetDispenser();
  }

  function resetDispenser(){
    // Ocultar todos los pasos
    document.querySelectorAll('.dispenser-step').forEach(step => {
      step.classList.add('hidden');
      step.classList.remove('active');
    });
    
    // Mostrar paso 1
    el('dispenserStep1').classList.add('active');
    el('dispenserStep1').classList.remove('hidden');
    
    // NUEVO: Predefinir datos de prueba
    el('dispenserCC').value = '12345678';
    el('dispenserPassword').value = 'ana12345';
    el('dispenserSystemKey').value = 'admin123';
    el('dispenserPickupCode').value = '';
    
    // Enfocar el primer campo
    setTimeout(() => el('dispenserCC').focus(), 500);
  }

  function showStep(stepNumber){
    document.querySelectorAll('.dispenser-step').forEach(step => {
      step.classList.add('hidden');
      step.classList.remove('active');
    });
    el(`dispenserStep${stepNumber}`).classList.add('active');
    el(`dispenserStep${stepNumber}`).classList.remove('hidden');
  }

  function initDispenserUI(){
    // Event Listeners para el dispensador
    el('btnVerifyCC').onclick = async function(){
      const cc = el('dispenserCC').value.trim();
      const password = el('dispenserPassword').value;
      
      if(!cc || !password) {
        alert('Por favor ingrese cédula y contraseña');
        return;
      }
      
      // Verificar credenciales con el nuevo endpoint
      this.disabled = true;
      this.textContent = 'VERIFICANDO...';
      
      try {
        const result = await fetch('/api/dispenser/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cc, password })
        });
        
        const data = await result.json();
        
        if(data.ok) {
          setTimeout(() => {
            showStep(2);
            this.disabled = false;
            this.textContent = 'VERIFICAR IDENTIDAD';
          }, 1000);
        } else {
          alert('Error: ' + data.error);
          this.disabled = false;
          this.textContent = 'VERIFICAR IDENTIDAD';
        }
      } catch(error) {
        console.error('Error verificando credenciales:', error);
        alert('Error de conexión al verificar credenciales');
        this.disabled = false;
        this.textContent = 'VERIFICAR IDENTIDAD';
      }
    };

    el('btnBackToStep1').onclick = () => showStep(1);
    el('btnBackToStep2').onclick = () => showStep(2);

    el('btnVerifySystemKey').onclick = function(){
      const systemKey = el('dispenserSystemKey').value;
      
      // Clave del sistema (en producción esto sería más seguro)
      if(systemKey === 'admin123') {
        showStep(3);
      } else {
        alert('Clave del sistema incorrecta');
      }
    };

    el('btnProcessPickup').onclick = async function(){
      const pickupCode = el('dispenserPickupCode').value.trim().toUpperCase();
      
      if(!pickupCode) {
        alert('Por favor ingrese el código de retiro');
        return;
      }
      
      this.disabled = true;
      this.textContent = 'PROCESANDO...';
      
      try {
        // Mostrar animación de dispensación
        showStep(4);
        el('dispenserResultTitle').textContent = 'PROCESANDO RETIRO...';
        el('dispenserResultTitle').style.color = '#3498db';
        
        // Esperar 3 segundos para la animación
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Usar el endpoint real de pickup
        const result = await api('/api/pickup', {
          method: 'POST',
          body: JSON.stringify({ code: pickupCode })
        });
        
        if(result.ok) {
          // Mostrar resultado exitoso
          el('dispenserResultTitle').textContent = '✅ RETIRO EXITOSO';
          el('dispenserResultTitle').style.color = '#27ae60';
          
          // Obtener detalles de la reserva para mostrar
          const reservationDetails = await getReservationDetails(pickupCode);
          displayPickupResult(true, reservationDetails, result);
          
          // ACTUALIZAR DATOS EN LA APLICACIÓN PRINCIPAL
          await loadRx(); // Actualizar "Mis fórmulas"
          await loadHistory(); // Actualizar historial
          await loadDispensers(); // Actualizar inventario
          await loadSuggestions(); // Actualizar sugerencias
          
          // NUEVO: Generar y mostrar enlace para descargar PDF de entrega
          if (result.reservation_id) {
            const pdfLink = document.createElement('a');
            pdfLink.href = `/api/deliveries/${result.reservation_id}/pdf`;
            pdfLink.target = '_blank';
            pdfLink.textContent = '📄 Descargar Comprobante de Entrega';
            pdfLink.className = 'dispenser-btn web-mode';
            pdfLink.style.marginTop = '15px';
            pdfLink.style.display = 'block';
            
            const resultContent = el('dispenserResultContent');
            if (resultContent) {
              resultContent.appendChild(pdfLink);
            }
          }
          
        } else {
          // Mostrar error
          el('dispenserResultTitle').textContent = '❌ ERROR EN RETIRO';
          el('dispenserResultTitle').style.color = '#e74c3c';
          displayPickupResult(false, null, result);
        }
      } catch(error) {
        console.error('Error en dispensador:', error);
        el('dispenserResultTitle').textContent = '❌ ERROR DEL SISTEMA';
        el('dispenserResultTitle').style.color = '#e74c3c';
        displayPickupResult(false, null, { error: 'Error de conexión' });
      } finally {
        this.disabled = false;
        this.textContent = 'PROCESAR RETIRO';
      }
    };

    el('btnNewPickup').onclick = resetDispenser;
    
    // NUEVO: Botón para salir del modo dispensador en el paso 4
    const btnExitDispenserFromResult = document.createElement('button');
    btnExitDispenserFromResult.id = 'btnExitDispenserFromResult';
    btnExitDispenserFromResult.className = 'dispenser-btn exit';
    btnExitDispenserFromResult.textContent = 'SALIR DEL MODO DISPENSADOR';
    btnExitDispenserFromResult.onclick = function() {
      el('dispenserSection').classList.add('hidden');
      el('appSection').classList.remove('hidden');
    };
    
    // Añadir el botón al paso 4 (resultado) - debajo del botón "NUEVO RETIRO"
    const step4 = el('dispenserStep4');
    if (step4) {
      const existingContainer = step4.querySelector('.dispenser-buttons');
      if (existingContainer) {
        // Verificar si el botón ya existe para no duplicarlo
        const existingBtn = step4.querySelector('#btnExitDispenserFromResult');
        if (!existingBtn) {
          existingContainer.appendChild(btnExitDispenserFromResult);
        }
      } else {
        // Crear contenedor de botones si no existe
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'dispenser-buttons';
        buttonsContainer.appendChild(el('btnNewPickup'));
        buttonsContainer.appendChild(btnExitDispenserFromResult);
        step4.appendChild(buttonsContainer);
      }
    }
    
    const btnExitDispenser = el('btnExitDispenser');
    if(btnExitDispenser){
      btnExitDispenser.onclick = function(){
        el('dispenserSection').classList.add('hidden');
        el('appSection').classList.remove('hidden');
      };
    }

    async function getReservationDetails(code){
      try {
        // Obtener detalles reales de la reserva
        const reservation = await fetch(`/api/reservations/${code}/details`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }).then(r => r.json());
        
        if(reservation && !reservation.error) {
          return {
            patientName: reservation.patientName || 'Ana Paciente',
            medications: reservation.medications || [],
            totalUnits: reservation.totalUnits || 0,
            timestamp: new Date().toLocaleString()
          };
        }
      } catch(error) {
        console.log('No se pudieron obtener detalles de la reserva, usando datos por defecto');
      }
      
      // Datos por defecto si no se pueden obtener los reales
      return {
        patientName: 'Ana Paciente',
        medications: [
          { name: 'Acetaminofén 500mg', units: 10 },
          { name: 'Metformina 850mg', units: 5 }
        ],
        totalUnits: 15,
        timestamp: new Date().toLocaleString()
      };
    }

    function displayPickupResult(success, details, result){
      const resultContent = el('dispenserResultContent');
      resultContent.className = 'dispenser-result ' + (success ? 'success' : 'error');
      
      if(success) {
        resultContent.innerHTML = `
          <div style="text-align: center;">
            <h3 style="color: #27ae60; margin-bottom: 15px;">¡RETIRO EXITOSO!</h3>
            <p><strong>Paciente:</strong> ${details?.patientName || 'N/A'}</p>
            <p><strong>Cédula:</strong> ${el('dispenserCC').value}</p>
            <p><strong>Código:</strong> ${el('dispenserPickupCode').value}</p>
            <p><strong>Fecha/Hora:</strong> ${details?.timestamp || new Date().toLocaleString()}</p>
            <div class="dispenser-medication-list">
              <h4>Medicamentos Entregados:</h4>
              ${details?.medications ? details.medications.map(med => 
                `<div class="dispenser-medication-item">
                  <span>${med.name}</span>
                  <span>${med.units} u</span>
                 </div>`
              ).join('') : '<p>Medicamentos dispensados correctamente</p>'}
            </div>
            <p><strong>Total de unidades:</strong> ${details?.totalUnits || result.totalUnits || 'N/A'}</p>
            <p style="color: #27ae60; font-weight: bold; margin-top: 15px;">¡Gracias por usar MediStock!</p>
          </div>
        `;
      } else {
        resultContent.innerHTML = `
          <div style="text-align: center;">
            <h3 style="color: #e74c3c; margin-bottom: 15px;">ERROR EN EL RETIRO</h3>
            <p><strong>Motivo:</strong> ${result.error || 'Error desconocido'}</p>
            <p><strong>Código:</strong> ${el('dispenserPickupCode').value}</p>
            <p>Por favor verifique el código e intente nuevamente.</p>
            <p style="color: #e74c3c; font-weight: bold; margin-top: 15px;">Contacte al administrador si el problema persiste.</p>
          </div>
        `;
      }
    }
  }

  // Inicializar UI del dispensador al cargar
  document.addEventListener('DOMContentLoaded', ()=>{ 
    bindGlobalUI(); 
    bindNavUI(); 
    bindProfileEditUI(); 
    bindProfileUI();
    initDispenserUI();
  });
})();
