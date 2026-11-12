import {displayTracks,needsRecenter} from './map-route.js';
import {routeStyle} from './route-style.js';
import {wrap, distance, bearing, arrowBearing, arrowYaw, buildNavigation, facingTarget} from './navigation.js?v=20261105-mapcenter';

const $ = id => document.getElementById(id);
let data, stations, byId, graph, viewer, map, marker, cone, surveyLayer;
const routeLayers = new Map();
let displayedRoute = null;
let navigation, pendingVisit = null, failedVisit = null;
const visitHistory = [];
let current = null, pending = null, busy = false, failed = null, serial = 0;
let lastAzimuth = null, lastFov = null, noticeTimer, loadStarted, preloadTimer = null;
const preloads = new Map();

function panoUrl(station) { return station.url; }

function notify(message, duration = 0) {
  clearTimeout(noticeTimer);
  const n = $('notice');
  if (!n) return;
  if ($('walk-choices')) $('walk-choices').hidden = true;
  n.textContent = message;
  n.hidden = !message;
  if (duration) noticeTimer = setTimeout(() => { n.hidden = true; }, duration);
}

function forwardTarget() {
  return current && viewer ? facingTarget(current, graph, byId, current.heading + viewer.getYaw(), stations) : null;
}

function controls() {
  $('back').disabled = busy || !visitHistory.length;
  // Keep Forward available so a blocked direction can explain how to continue.
  $('forward').disabled = busy || !current;
  $('turn-around').disabled = busy || !current;
  $('photo-select').disabled = busy;
  document.body.classList.toggle('loading', busy);
}

function turnAround() {
  if (!current || busy || !viewer) return;
  viewer.setYaw(wrap(viewer.getYaw()+180),450);
  notify('');
}
function courseAzimuth(st) {
  const route=stations.filter(s=>s.segmentId===st.segmentId);
  const index=route.findIndex(s=>s.id===st.id);
  const ahead=route.slice(index+1).find(s=>distance(st,s)>=8);
  const behind=route.slice(0,index).reverse().find(s=>distance(st,s)>=8);
  return ahead?bearing(st,ahead):behind?bearing(behind,st):st.heading;
}
function faceCourse() {
  if (!current || busy || !viewer) return;
  viewer.setYaw(wrap(courseAzimuth(current)-current.heading),450);viewer.setPitch(-5,450);
}

function preload(station, isUserNavigation = false) {
  if (!station) return Promise.resolve();
  const url = panoUrl(station);
  if (preloads.has(url)) {
    const existing = preloads.get(url);
    if (!existing.failed) return existing.promise;
    preloads.delete(url);
  }

  const timeoutMs = isUserNavigation ? 35000 : 15000;
  let timer;
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    timer = setTimeout(() => {
      img.src = '';
      reject(Error('Image request timed out'));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(url);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(Error('Image unavailable'));
    };
    img.src = url;
  });

  const entry = { promise, failed: false };
  promise.catch(() => {
    entry.failed = true;
    preloads.delete(url);
  });
  preloads.set(url, entry);

  while (preloads.size > 24) {
    preloads.delete(preloads.keys().next().value);
  }
  return promise;
}

function schedulePreload(stationId) {
  clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    for (const id of graph.get(stationId) || []) preload(byId.get(id), false).catch(() => {});
  }, 80);
}

function hotspots(station) {
  return (graph.get(station.id) || []).map(id => {
    const target = byId.get(id);
    if (!target) return null;
    const d = distance(station, target);
    const label = 'Continue along the river';
    return {
      id: `walk-${id}`,
      yaw: arrowYaw(station, target, stations),
      // Very short capture spacing must not put the walking arrow below the viewport.
      pitch: -Math.min(18, Math.max(8, Math.atan2(data.cameraHeight || 1.95, Math.max(2, d)) * 180 / Math.PI)),
      cssClass: 'ground-arrow',
      createTooltipFunc: div => {
        div.innerHTML = '<svg viewBox="0 0 72 44" aria-hidden="true"><path d="M8 32 L36 12 L64 32"/></svg>';
        const tip = document.createElement('span');
        tip.textContent = label;
        div.append(tip);
        div.tabIndex = 0;
        div.setAttribute('role', 'button');
        div.setAttribute('aria-label', label);
        div.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            go(target);
          }
        });
      },
      clickHandlerFunc: () => go(target)
    };
  }).filter(Boolean);
}

function refreshWaypoints() {
  if (!viewer || !current || busy) return;
  for (const h of [...(viewer.getConfig().hotSpots || [])]) if (h.id?.startsWith('wp-')) viewer.removeHotSpot(h.id);
  for (const h of window.buffaloWaypoints?.(current) || []) viewer.addHotSpot(h);
}
function scene(station) {
  return {
    type: 'equirectangular',
    panorama: panoUrl(station),
    northOffset: station.heading,
    ignoreGPanoXMP: true,
    hotSpots: [...hotspots(station), ...(window.buffaloWaypoints?.(station) || [])]
  };
}

function updateCone(st, yawDeg = 0, fovDeg = 105) {
  if (!cone || !st) return;
  const az = wrap((st.heading || 0) + yawDeg);
  const r = Math.PI / 180, radius = 45, points = [[st.lat, st.lon]];
  for (let i = 0; i <= 12; i++) {
    const a = (az - fovDeg / 2 + fovDeg * i / 12) * r;
    points.push([
      st.lat + radius * Math.cos(a) / 111320,
      st.lon + radius * Math.sin(a) / (111320 * Math.cos(st.lat * r))
    ]);
  }
  cone.setLatLngs(points);
}

function syncMap() {
  if (!viewer || !current || busy || !viewer.isLoaded()) return;
  const az = wrap(current.heading + viewer.getYaw()), fov = viewer.getHfov();
  if (lastAzimuth !== null && Math.abs(wrap(az - lastAzimuth)) < 0.3 && Math.abs(fov - lastFov) < 0.3) return;
  lastAzimuth = az;
  lastFov = fov;
  updateCone(current, viewer.getYaw(), fov);
}

function finish() {
  if (!pending) return;
  if (pendingVisit?.back) visitHistory.pop();
  else if (current && current.id !== pending.id) visitHistory.push(current.id);
  if (pendingVisit?.reset) visitHistory.length = 0;
  pendingVisit = null;
  current = pending;
  pending = null;
  busy = false;
  failed = null;
  failedVisit = null;
  if ($('retry')) $('retry').hidden = true;

  const panoEl = $('panorama');
  if (panoEl) {
    panoEl.dataset.station = current.id;
    panoEl.dataset.transitionMs = String(Math.round(performance.now() - loadStarted));
  }

  if (marker) {
    marker.setLatLng([current.lat, current.lon]);
    marker.bringToFront();
  }
  if (map) followMap();

  lastAzimuth = null;
  syncMap();
  controls();

  if ($('image-info')) {
    $('image-info').textContent = `${current.id} · ${current.lat.toFixed(6)}, ${current.lon.toFixed(6)} · ${current.date.slice(0, 10)}`;
  }
  updateCaptureStamp(current);
  window.dispatchEvent(new CustomEvent("buffalo-view",{detail:current}));



  const url = new URL(location.href);
  url.searchParams.set('station', current.id);
  url.hash = '';
  for (const key of ['yaw', 'pitch', 'fov']) url.searchParams.delete(key);
  history.replaceState(null, '', url);

  if ($('share-url')) $('share-url').value = shareUrl();

  const photos = navigation.groups.get(current.id);
  $('photo-group').hidden = photos.length < 2;
  $('photo-select').replaceChildren(...photos.map((st,i) => new Option(`View ${i+1}`, st.id)));
  $('photo-select').value = current.id;
  notify('');

  // Invalidate map size so newly visible tiles render immediately
  if (map) map.invalidateSize();

  // Purge distant scenes from Pannellum to free GPU VRAM and eliminate hitching
  if (viewer) {
    const keepScenes = new Set([current.id]);
    const neighbors = graph.get(current.id) || [];
    for (const nid of neighbors) keepScenes.add(nid);
    const cfg = viewer.getConfig();
    if (cfg && cfg.scenes) {
      for (const sid of Object.keys(cfg.scenes)) {
        if (!keepScenes.has(sid)) {
          viewer.removeScene(sid);
        }
      }
    }
  }

  // Schedule immediate predictive preloading of adjacent stations
  schedulePreload(current.id);
}

function fail(error) {
  console.error(error);
  busy = false;
  failed = pending;
  failedVisit = pendingVisit;
  pending = null;
  pendingVisit = null;
  controls();
  if ($('retry')) $('retry').hidden = false;
  notify('This view could not load. Try again or choose another map point.', 6000);
}

async function go(target, {initial = false, reset = false, view = null, back = false} = {}) {
  if (!target) return;
  if (busy) return;

  busy = true;
  pending = target;
  pendingVisit = {back, reset};

  controls();
  if ($('retry')) $('retry').hidden = true;

  // Commit marker, cone and map only after the matching panorama is loaded.
  const token = ++serial;
  loadStarted = performance.now();
  const loadingTimer = setTimeout(() => notify('Opening view…'), 300);

  try {
    await preload(target, true);
    if (token !== serial) return;
    clearTimeout(loadingTimer);

    // Determine the forward target continuation from target
    const neighbors = (graph.get(target.id) || []).map(id => byId.get(id)).filter(Boolean);
    let nextForward = null;

    if (current && !reset) {
      if (back) {
        // When stepping back, face along the backwards trajectory or maintain trail forward
        const prevStation = visitHistory.length > 1 ? byId.get(visitHistory.at(-2)) : null;
        nextForward = prevStation && neighbors.some(n => n.id === prevStation.id)
          ? prevStation
          : neighbors.find(n => n.id !== current.id) || current;
      } else {
        const incomingMotion = arrowBearing(current, target, stations);
        const forwardOptions = neighbors.filter(n => n.id !== current.id);
        if (forwardOptions.length === 1) {
          nextForward = forwardOptions[0];
        } else if (forwardOptions.length > 1) {
          // At a junction/fork, select the path closest to our incoming motion vector
          nextForward = forwardOptions.sort((a, b) =>
            Math.abs(wrap(arrowBearing(target, a, stations) - incomingMotion)) -
            Math.abs(wrap(arrowBearing(target, b, stations) - incomingMotion))
          )[0];
        }
      }
    } else {
      // Initial load or direct map jump: pick forward sequential neighbor
      nextForward = neighbors.find(n => n.seq > target.seq);
    }

    // Centering the next arrow:
    // If nextForward exists, setting viewer yaw to arrowYaw(target, nextForward, stations)
    // centers the next directional arrow dead-on in the viewport.
    const targetYaw = nextForward
      ? arrowYaw(target, nextForward, stations)
      : wrap((initial || reset || !current ? courseAzimuth(target) : arrowBearing(current, target, stations)) - target.heading);

    const yaw = view?.yaw ?? targetYaw;
    const pitch = view?.pitch ?? (current && viewer && !reset ? Math.max(-10, Math.min(-2, viewer.getPitch())) : -5);
    const hfov = view?.hfov ?? (current && viewer && !reset ? viewer.getHfov() : innerWidth < 600 ? 75 : 105);

    if (!viewer) {
      viewer = pannellum.viewer('panorama', {
        default: {
          firstScene: target.id,
          autoLoad: true,
          showControls: false,
          compass: false,
          sceneFadeDuration: 0,
          minHfov: 45,
          maxHfov: 120,
          minPitch: -90,
          maxPitch: 70,
          friction: 0.16,
          capturedKeyNumbers: [37, 39, 187, 189],
          backgroundColor: [0.06, 0.09, 0.16]
        },
        scenes: {[target.id]: {...scene(target), pitch, yaw, hfov}}
      });
      viewer.on('load', finish);
      viewer.on('error', fail);
    } else {
      viewer.addScene(target.id, scene(target));
      viewer.loadScene(target.id, pitch, yaw, hfov);
    }
  } catch (error) {
    clearTimeout(loadingTimer);
    fail(error);
  }
}

function step(direction) {
  if (!current || busy) return;
  if (direction < 0) {
    const previous = byId.get(visitHistory.at(-1));
    if (previous) go(previous, {back:true});
    return;
  }
  const next = forwardTarget();
  if (next) go(next);
  else {
    const links = graph.get(current.id);
    notify(links.length ? 'Follow an arrow or choose a direction.' : 'End of this connected route. Choose another location on the map.', 4000);
    const world = current.heading + viewer.getYaw();
    const ordered = [...links].sort((a,b) => wrap(arrowBearing(current, byId.get(a), stations) - world) - wrap(arrowBearing(current, byId.get(b), stations) - world));
    $('walk-choices').replaceChildren(...ordered.map((id,index) => {
      const target = byId.get(id), button = document.createElement('button');
      const angle = wrap(arrowBearing(current, target, stations) - world);
      button.textContent = Math.abs(angle)>120 ? 'Turn back' : ordered.length>1 ? (index===0 ? 'Take the left path' : index===ordered.length-1 ? 'Take the right path' : 'Continue ahead') : 'Continue along the river';
      button.onclick = () => go(target);
      return button;
    }));
    $('walk-choices').hidden = !links.length;
  }
}

function refreshMapRoutes() {
  const all = document.body.classList.contains('records-mode');
  const selected = current?.segmentId || data.initialView.segmentId;
  map.getContainer().dataset.routeFilter=all?'all':selected;
  const color=routeStyle(selected).color;
  document.documentElement.style.setProperty('--route-color',color);
  marker?.setStyle({fillColor:color});cone?.setStyle({color,fillColor:color});
  for (const [id,layer] of routeLayers) {
    if (all || id===selected) {if(!map.hasLayer(layer))layer.addTo(map);}
    else if(map.hasLayer(layer))map.removeLayer(layer);
  }
}
function followMap() {
  const routeChanged = displayedRoute !== current.segmentId;
  displayedRoute = current.segmentId;
  refreshMapRoutes();
  if(document.body.classList.contains('records-mode'))return;
  const location=[current.lat,current.lon];
  if(routeChanged || needsRecenter(map.latLngToContainerPoint(location),map.getSize())) {
    map.stop();map.panTo(location,{animate:false});
  }
}
function initMap() {
  map = L.map('map', {zoomControl: false, attributionControl: false}).setView([data.initialView.lat, data.initialView.lon], 17);

  L.tileLayer('https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 19,
    maxZoom: 21,
    attribution: '',
    keepBuffer: 4,
    updateWhenIdle: false,
    updateWhenZooming: false
  }).addTo(map);

  L.control.zoom({position: 'bottomright'}).addTo(map);

  if (map.attributionControl) {
    map.removeControl(map.attributionControl);
  }
  const purgeAttribution = () => {
    document.querySelectorAll('.leaflet-control-attribution').forEach(el => el.remove());
  };
  purgeAttribution();
  map.on('load move zoomend layeradd', purgeAttribution);
  setInterval(purgeAttribution, 1000);

  for (const track of displayTracks(navigation)) {
    const symbol=routeStyle(track.segmentId);
    let layer=routeLayers.get(track.segmentId);
    if(!layer){layer=L.layerGroup();routeLayers.set(track.segmentId,layer);}
    L.polyline(track.points.map(s=>[s.lat,s.lon]),{color:symbol.color,weight:3,opacity:1,interactive:false,smoothFactor:0}).addTo(layer);
    for(const s of track.raw){L.circleMarker([s.lat,s.lon],{radius:symbol.radius,color:symbol.color,weight:symbol.weight,fillColor:symbol.color,fillOpacity:1}).addTo(layer).bindTooltip(track.segmentId).on('click',()=>go(s));}
  }
  surveyLayer=L.layerGroup();
  refreshMapRoutes();
  cone = L.polygon([], {color: routeStyle(data.initialView.segmentId).color, weight: 1, fillOpacity: 0.35, interactive: false}).addTo(map);
  marker = L.circleMarker([data.initialView.lat, data.initialView.lon], {
    interactive: false,
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: routeStyle(data.initialView.segmentId).color,
    fillOpacity: 1
  }).addTo(map);

  // Immediately draw active cone and marker from frame 0
  updateCone(data.initialView, 0, data.initialView.fov_deg || 105);
  marker.bringToFront();

  // Invalidate map size multiple times to ensure full viewport fill inside iframes & grid containers
  requestAnimationFrame(() => map && map.invalidateSize());
  setTimeout(() => map && map.invalidateSize(), 200);
  setTimeout(() => map && map.invalidateSize(), 800);
}

function shareUrl() {
  let base = location.href;
  if (data?.shareBaseUrl) {
    base = data.shareBaseUrl;
  }
  const url = new URL(base);
  if (current) url.searchParams.set('station', current.id);
  if (viewer && viewer.isLoaded()) {
    url.searchParams.set('yaw', viewer.getYaw().toFixed(2));
    url.searchParams.set('pitch', viewer.getPitch().toFixed(2));
    url.searchParams.set('fov', viewer.getHfov().toFixed(2));
  }
  return url.href;
}

function settings(open) {
  const panel = $('settings');
  if (!panel) return;
  panel.hidden = !open;
  if ($('options')) $('options').setAttribute('aria-expanded', String(open));
  if (open) {
    if ($('share-url')) $('share-url').value = shareUrl();
    if ($('close-settings')) $('close-settings').focus();
  } else {
    if ($('options')) $('options').focus();
  }
}

function bind() {
  $('turn-around').onclick = turnAround;
  $('photo-select').onchange = e => go(byId.get(e.target.value));
  if ($('back')) $('back').onclick = () => step(-1);
  if ($('forward')) $('forward').onclick = () => step(1);
  if ($('home')) $('home').onclick = () => go(byId.get(data.initialView.station_id) || stations[0], {reset: true});
  if ($('retry')) $('retry').onclick = () => go(failed || current || stations[0], failedVisit || {});
  if ($('options')) $('options').onclick = () => settings($('settings') ? $('settings').hidden : true);
  if ($('close-settings')) $('close-settings').onclick = () => settings(false);
  if ($('survey')) $('survey').onchange = e => e.target.checked ? surveyLayer.addTo(map) : map.removeLayer(surveyLayer);

  const toggleMapAction = () => {
    const panel = $('map-panel');
    if (!panel) return;
    const collapsed = panel.classList.toggle('collapsed');
    if ($('toggle-map')) {
      $('toggle-map').textContent = collapsed ? '+' : '−';
      $('toggle-map').setAttribute('aria-label', collapsed ? 'Show map' : 'Hide map');
      $('toggle-map').setAttribute('aria-expanded', String(!collapsed));
    }
    setTimeout(() => map && map.invalidateSize(), 250);
  };

  if ($('toggle-map')) $('toggle-map').onclick = toggleMapAction;

  if ($('expand-map')) {
    $('expand-map').onclick = () => {
      const panel = $('map-panel');
      if (!panel) return;
      const expanded = panel.classList.toggle('expanded');
      $('expand-map').setAttribute('aria-expanded', String(expanded));
      $('expand-map').setAttribute('aria-label', expanded ? 'Shrink map' : 'Expand map');
      setTimeout(() => map && map.invalidateSize(), 250);
    };
  }

  if ($('fullscreen')) {
    $('fullscreen').onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        notify('Full screen is unavailable in this browser.', 4000);
      }
    };
  }

  if ($('share-url')) $('share-url').onclick = () => $('share-url').select();
  if ($('share')) {
    $('share').onclick = async () => {
      if (!current || busy) return;
      const url = shareUrl();
      try {
        await navigator.clipboard.writeText(url);
        notify('Link to this view copied to clipboard.', 3000);
      } catch {
        settings(true);
        if ($('share-fallback')) $('share-fallback').hidden = false;
        if ($('share-url')) {
          $('share-url').value = url;
          $('share-url').focus();
          $('share-url').select();
        }
      }
    };
  }

  addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('settings') && !$('settings').hidden) {
      settings(false);
      return;
    }
    if (document.body.classList.contains('records-mode') || e.target.closest('input,select,textarea,button,[role="button"],summary') || ($('settings') && !$('settings').hidden)) return;
    if (['w', 'W', 'ArrowUp', 's', 'S', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      step(['w', 'W', 'ArrowUp'].includes(e.key) ? 1 : -1);
    }
  });

  const mapPanel = $('map-panel');
  if (mapPanel) {
    new ResizeObserver(() => {
      map?.invalidateSize();
      viewer?.resize();
    }).observe(mapPanel);
  }

  setInterval(syncMap, 80);
}

async function boot() {
  const response = await fetch('data/walkthrough.json?v=' + Date.now());
  if (!response.ok) throw Error('Catalog unavailable');
  data = await response.json();
  stations = data.stations;
  byId = new Map(stations.map(s => [s.id, s]));
  navigation = buildNavigation(stations, data.reviewedLinks);
  graph = navigation.graph;

  data.tourLines = navigation.lines;
  initMap();
  window.buffalo = {map, stations, go, getCurrent:()=>current, distance, refreshMapRoutes, refreshWaypoints, faceCourse, lookAt:(p)=>{if(viewer&&current&&!busy){viewer.setYaw(wrap(bearing(current,p)-current.heading),500);viewer.setPitch(0,500);}}};
  bind();

  const params = new URLSearchParams(location.search);
  const requested = params.get('station');
  const target = byId.get(requested) || byId.get(data.initialView.station_id) || stations[0];
  const finite = (name, fallback, min, max) =>
    params.has(name) && Number.isFinite(Number(params.get(name)))
      ? Math.max(min, Math.min(max, Number(params.get(name))))
      : fallback;
  const view = params.has('yaw')
    ? {yaw: finite('yaw', 0, -180, 180), pitch: finite('pitch', 0, -90, 70), hfov: finite('fov', 105, 45, 120)}
    : null;

  await go(target, {initial: true, view});
}

boot().catch(error => {
  console.error(error);
  notify('The walkthrough could not start. Please refresh.');
});


function updateCaptureStamp(st) {
  if (!st) return;
  const capVal = $('stamp-capture-val');
  const coordVal = $('stamp-coords-val');
  if (!capVal || !coordVal) return;

  let dateStr = '';
  const rawDate = st.date || st.exifDate || '';
  const m = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (m) {
    const yr = m[1].slice(-2);
    const mo = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    let hr = parseInt(m[4], 10);
    const min = m[5];
    const ampm = hr >= 12 ? 'PM' : 'AM';
    hr = hr % 12 || 12;
    dateStr = `${mo}/${day}/${yr}, ${hr}:${min} ${ampm}`;
  } else if (rawDate) {
    try {
      const d = new Date(rawDate.includes('T') ? rawDate : rawDate.replace(' ', 'T'));
      if (!isNaN(d.getTime())) {
        const mo = d.getMonth() + 1;
        const day = d.getDate();
        const yr = String(d.getFullYear()).slice(-2);
        let hr = d.getHours();
        const min = String(d.getMinutes()).padStart(2, '0');
        const ampm = hr >= 12 ? 'PM' : 'AM';
        hr = hr % 12 || 12;
        dateStr = `${mo}/${day}/${yr}, ${hr}:${min} ${ampm}`;
      }
    } catch (e) {}
  }

  capVal.textContent = dateStr || 'Unknown';
  coordVal.textContent = `${Number(st.lat).toFixed(6)} ${Number(st.lon).toFixed(6)}`;
}
