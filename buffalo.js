import {installWaypoints,range,rangeLabel} from './waypoints.js';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,n=2)=>v==null?'Unavailable':Number(v).toLocaleString('en-US',{maximumFractionDigits:n,minimumFractionDigits:n});
const date=v=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'}).format(new Date(v));
const cardinal=d=>Number.isFinite(d)?`${['N','NE','E','SE','S','SW','W','NW'][Math.round(((d%360)+360)%360/45)%8]} (${Math.round(d)}°)`:'';
let catalog, config, active, panel=null, selectedPhoto=null, pinnedRiver=null, renderToken=0;
let recordsMap=null, exploreMapView=null;
const records=new Map();
const media=p=>`${config.serviceUrl}/1/${p.OBJECTID}/attachments/${p.attachmentId}`;
const dist=(a,b)=>window.buffalo.distance({lat:a.y??a.lat,lon:a.x??a.lon},{lat:b.y??b.lat,lon:b.x??b.lon});
function setSection(records){
 const wasRecords=document.body.classList.contains('records-mode');
 document.body.classList.toggle('records-mode',records);$('records-page').hidden=!records;
 $('explore-tab').setAttribute('aria-current',records?'false':'page');$('records-tab').setAttribute('aria-current',records?'page':'false');
 $('settings').hidden=true;$('options').setAttribute('aria-expanded','false');
 const map=window.buffalo?.map;
 if(active)$('records-caption').textContent=`Linked to your current view · ${date(active.date)} CDT`;
 if(records){if(!wasRecords&&map)exploreMapView={center:map.getCenter(),zoom:map.getZoom()};$('records-map-host').append($('map-panel'));$('records-detail-host').append($('context-panel'));$('map-panel').classList.remove('collapsed','expanded');$('context-panel').hidden=false;}
 else{document.body.append($('map-panel'));$('context-panel').hidden=true;}
 if(map){recordsMap?.setRecordsMode(records);window.buffalo.refreshMapRoutes();map.invalidateSize();if(!records&&wasRecords&&exploreMapView)map.setView(exploreMapView.center,exploreMapView.zoom,{animate:false});}
 const url=new URL(location.href);records?url.searchParams.set('tab','records'):url.searchParams.delete('tab');history.replaceState(null,'',url);
}
function closePanel(){setSection(false);}
function openPanel(kind){panel=kind;setSection(true);$('open-photos').setAttribute('aria-pressed',String(kind==='photos'));$('open-river').setAttribute('aria-pressed',String(kind==='river'));render();}
function photoCard(p){const km=active?dist(active,p)/1000:null,dir=cardinal(p.Direction);return `<button class="photo-card" data-photo="${p.OBJECTID}"><img loading="lazy" src="${esc(media(p))}" alt="Field photo taken ${esc(date(p.CaptureDateISO))}"><span>${esc(date(p.CaptureDateISO))}<small>${dir?`Facing ${esc(dir)}`:''}${dir&&km!==null?' · ':''}${km===null?'':`${fmt(km,1)} km from this view`}</small></span></button>`;}
function photoGrid(){
 $('context-title').textContent='Field photos';
 $('context-body').innerHTML=`<p class="panel-intro">Choose a photo below or a purple location on the map.</p><label>Capture date<select id="photo-date"><option value="all">All dates · ${catalog.phone.length} photos</option></select></label><div class="filter-row"><label>Order<select id="photo-order"><option value="near">Nearest to this view</option><option value="date">Capture time</option></select></label><span id="photo-result" role="status"></span></div><div id="photo-grid"></div>`;
 const days=[...new Set(catalog.phone.map(p=>p.PhotoDateCDT))].sort();for(const d of days)$('photo-date').add(new Option(d,d));
 function fill(){let photos=catalog.phone.filter(p=>$('photo-date').value==='all'||p.PhotoDateCDT===$('photo-date').value);photos.sort($('photo-order').value==='near'&&active?(a,b)=>dist(active,a)-dist(active,b):(a,b)=>a.CaptureDateISO.localeCompare(b.CaptureDateISO));$('photo-result').textContent=`${photos.length} pictures`;$('photo-grid').innerHTML=photos.map(photoCard).join('');$('photo-grid').querySelectorAll('[data-photo]').forEach(b=>b.onclick=()=>showPhoto(catalog.phone.find(p=>p.OBJECTID===Number(b.dataset.photo))));}
 $('photo-date').onchange=$('photo-order').onchange=fill;fill();
}
function showPhotoGroup(group){
 if(group.photos.length===1){showPhoto(group.photos[0]);return;}
 openPanel('photos');$('context-title').textContent='Photos at this waypoint';
 $('context-body').innerHTML=`<p class="panel-intro">${group.photos.length} photos near this location · ${active?rangeLabel(range(active,group))+' from the active panorama':''}. Photos can be from a different visit.</p><button id="all-field-photos">Browse all field photos</button><div id="photo-grid">${group.photos.map(photoCard).join('')}</div>`;
 $('all-field-photos').onclick=photoGrid;$('photo-grid').querySelectorAll('[data-photo]').forEach(b=>b.onclick=()=>showPhoto(catalog.phone.find(p=>p.OBJECTID===Number(b.dataset.photo))));
}
async function showGauge(gauge){
 const snapshot=(pinnedRiver?.kind==='phone'?pinnedRiver:null)||($('photo-dialog')?.open&&selectedPhoto?selectedPhoto:null)||active;
 if(!snapshot)return;
 const snapIso=snapshot.CaptureDateISO||snapshot.date;
 try{if(!records.has(gauge.StationID)){const r=await fetch(`readings/${encodeURIComponent(gauge.StationID)}.json`);if(!r.ok)throw Error('Station record unavailable.');records.set(gauge.StationID,await r.json());}
 const rows=records.get(gauge.StationID).filter(r=>r.StationDayKey===`${gauge.StationID}|${snapshot.PhotoDateCDT}`);
 const nearest=[...rows].sort((a,b)=>Math.abs(Date.parse(a.ObservedCDT)-Date.parse(snapIso))-Math.abs(Date.parse(b.ObservedCDT)-Date.parse(snapIso)))[0];
 pinnedRiver={...snapshot,kind:'gauge',StationID:gauge.StationID,StationName:gauge.Name,StationDistanceKm:range(snapshot,gauge)/1000,WaterHeightFt:nearest?.WaterHeightFt??null,DischargeCFS:nearest?.DischargeCFS??null,WaterObservedCDT:nearest?.ObservedCDT||'',WaterTimeGapMin:nearest?Math.abs(Date.parse(nearest.ObservedCDT)-Date.parse(snapIso))/60000:null,WaterStatus:nearest?.Quality||'No observation on this capture date',WaterDatum:gauge.Datum};openPanel('river');
 }catch(e){$('river-chip').textContent=e.message;}
}
function showPhoto(p,updateLink=true){selectedPhoto=p;const dir=cardinal(p.Direction);$('field-photo').alt=`Buffalo River field photograph, ${date(p.CaptureDateISO)}`;$('field-photo').src=media(p);$('field-caption').textContent=`${date(p.CaptureDateISO)} CDT${dir?` · Facing ${dir}`:''} · ${p.y.toFixed(6)}, ${p.x.toFixed(6)}${p.PhotoFile?` · ${p.PhotoFile}`:''}`;$('photo-location').disabled=!active;if(!$('photo-dialog').open)$('photo-dialog').showModal();if(updateLink){const u=new URL(location.href);u.searchParams.set('photo',p.OBJECTID);history.replaceState(null,'',u);}}
function closePhoto(){ $('photo-dialog').close();const u=new URL(location.href);u.searchParams.delete('photo');history.replaceState(null,'',u); }
async function riverPanel(){
 const token=++renderToken, feature=pinnedRiver||active;if(!feature)return;
 const flowLabel=feature.DischargeCFS!=null?` · ${fmt(feature.DischargeCFS,0)} <small>cfs</small>`:'';
 const backwaterNote=feature.BackwaterHeightFt!=null&&feature.StationID==='USGS-07295000'?`<br>Downstream backwater (${esc(feature.BackwaterStationName)}): ${fmt(feature.BackwaterHeightFt)} ft (${esc(feature.BackwaterDatum)})`:'';
 $('context-title').textContent='River record';
 $('context-body').innerHTML=`<p class="panel-intro">Historical readings for ${esc(feature.kind==='gauge'?'the selected river station':feature.kind==='phone'?'the selected field photo':'this panorama')}. Gauge height is measured at the station; it is not water depth at the picture.</p><div class="reading-summary"><span>Matched reading · ${esc(feature.PhotoDateCDT)}</span><strong>${fmt(feature.WaterHeightFt)} <small>ft</small>${flowLabel}</strong><p>${esc(feature.StationName)}</p><small>${esc(feature.WaterObservedCDT?date(feature.WaterObservedCDT)+' CDT':'No matching observation')}<br>${fmt(feature.StationDistanceKm,1)} km from photo · ${fmt(feature.WaterTimeGapMin,1)} min time gap<br>${esc(feature.WaterStatus)}<br>${esc(feature.WaterDatum)}${backwaterNote}</small></div><label>River station<select id="river-station"></select></label><label>Record date<input type="date" id="river-date" min="2026-05-01" max="2026-08-31" value="${esc(feature.PhotoDateCDT)}"></label><p id="river-status" role="status"></p><div id="river-trend" aria-label="Daily gauge-height trend"></div><div class="readings-scroll"><table><thead><tr><th>Time (CDT)</th><th>Height (ft)</th><th>Flow (cfs)</th></tr></thead><tbody id="river-readings"></tbody></table></div><p id="river-source"></p><p class="panel-intro">Archive: May–August 2026. Each station has its own height reference; do not compare raw heights between stations.</p>${pinnedRiver?'<button id="follow-view">Follow panorama again</button>':''}`;
 for(const s of catalog.stations)$('river-station').add(new Option(s.Name,s.StationID));$('river-station').value=feature.StationID;
 let request=0;
 async function load(){const req=++request,id=$('river-station').value,day=$('river-date').value;$('river-status').textContent='Loading station record…';$('river-readings').replaceChildren();$('river-trend').replaceChildren();const station=catalog.stations.find(s=>s.StationID===id);$('river-source').innerHTML=`${esc(station.Datum)}<br><a href="${esc(station.SourceURL)}" target="_blank" rel="noopener">${esc(station.Agency)} · Source station ↗</a>`;
 try{if(!records.has(id)){const r=await fetch(`readings/${encodeURIComponent(id)}.json`);if(!r.ok)throw Error('River record could not load.');records.set(id,await r.json());}if(token!==renderToken||req!==request||panel!=='river')return;const rows=records.get(id).filter(r=>r.StationDayKey===`${id}|${day}`).sort((a,b)=>a.ObservedCDT.localeCompare(b.ObservedCDT));$('river-status').textContent=rows.length?`${rows.length} archived readings · ${day}`:'No archived readings for this date.';$('river-readings').innerHTML=rows.map(r=>`<tr class="${r.ObservedCDT===feature.WaterObservedCDT&&id===feature.StationID?'matched':''}" title="${esc(r.Quality)}"><td>${esc(r.ObservedCDT.slice(11,16))}</td><td>${fmt(r.WaterHeightFt)}</td><td>${fmt(r.DischargeCFS,0)}</td></tr>`).join('');
 const valid=rows.filter(r=>Number.isFinite(r.WaterHeightFt));if(valid.length>1){const lo=Math.min(...valid.map(r=>r.WaterHeightFt)),hi=Math.max(...valid.map(r=>r.WaterHeightFt));const points=valid.map((r,i)=>`${8+284*i/(valid.length-1)},${64-48*(r.WaterHeightFt-lo)/(hi-lo||1)}`).join(' ');$('river-trend').innerHTML=`<svg viewBox="0 0 300 80" role="img" aria-label="Gauge height range ${fmt(lo)} to ${fmt(hi)} feet over the selected day"><polyline points="${points}" fill="none" stroke="#f5a75b" stroke-width="2"/></svg><small>Daily range ${fmt(lo)}–${fmt(hi)} ft · oldest → newest</small>`;}}
 catch(e){if(token===renderToken&&req===request){$('river-status').textContent=e.message;const retry=document.createElement('button');retry.textContent='Retry record';retry.onclick=load;$('river-status').append(retry);}}}
 $('river-station').onchange=$('river-date').onchange=load;if($('follow-view'))$('follow-view').onclick=()=>{pinnedRiver=null;render();};await load();
}
function render(){renderToken++;if(panel==='photos')photoGrid();if(panel==='river')riverPanel();}
function sync(st){active=st;$('route-select').value=st.segmentId;const near=catalog.phone.filter(p=>dist(st,p)<=250).length;$('photo-count').textContent=near?`${near} nearby`:catalog.phone.length;$('river-chip').innerHTML=`<button id="chip-button">≋ ${fmt(st.WaterHeightFt)} ft <span>at gauge · ${esc(st.PhotoDateCDT)}</span></button>`;$('chip-button').onclick=()=>{pinnedRiver=null;openPanel('river');};if(panel==='river'&&!pinnedRiver)riverPanel();}
async function init(){[catalog,config]=await Promise.all(['data.json','config.json'].map(async u=>{const r=await fetch(u);if(!r.ok)throw Error('Catalog could not load.');return r.json();}));
 const routes=[...new Set(catalog.panorama.map(s=>s.OriginalRoute))];for(const route of routes)$('route-select').add(new Option(route.replace(' Route',''),route));$('route-select').onchange=e=>{closePhoto();pinnedRiver=null;const st=window.buffalo?.stations.find(s=>s.segmentId===e.target.value);if(st)window.buffalo.go(st,{reset:true});};
 $('open-photos').onclick=()=>openPanel('photos');$('open-river').onclick=()=>{pinnedRiver=null;openPanel('river');};$('close-context').onclick=closePanel;$('close-photo').onclick=closePhoto;
 $('photo-dialog').addEventListener('cancel',e=>{e.preventDefault();closePhoto();});$('field-photo').onerror=()=>{$('field-caption').textContent='This photo could not load. Close it and try again.';};
 $('photo-location').onclick=()=>{if(!selectedPhoto||!window.buffalo)return;const target=[...window.buffalo.stations].sort((a,b)=>dist(a,selectedPhoto)-dist(b,selectedPhoto))[0];closePhoto();closePanel();window.buffalo.go(target,{reset:true});};$('photo-river').onclick=()=>{pinnedRiver=selectedPhoto;closePhoto();openPanel('river');};
 window.addEventListener('buffalo-view',e=>sync(e.detail));if(window.buffalo?.getCurrent())sync(window.buffalo.getCurrent());const photoId=Number(new URL(location.href).searchParams.get('photo'));const sharedPhoto=catalog.phone.find(p=>p.OBJECTID===photoId);if(sharedPhoto)showPhoto(sharedPhoto,false);
 const attachMap=()=>{if(!window.buffalo)return setTimeout(attachMap,100);recordsMap=installWaypoints(catalog,{onPhotoGroup:showPhotoGroup,onGauge:showGauge});if(document.body.classList.contains('records-mode'))recordsMap.setRecordsMode(true);};attachMap();
 $('explore-tab').onclick=()=>setSection(false);$('records-tab').onclick=()=>openPanel(panel||'photos');
 if(new URL(location.href).searchParams.get('tab')==='records')openPanel('photos');
 addEventListener('keydown',e=>{if(e.key==='Escape')closePanel();});
}
init().catch(e=>{$('river-chip').textContent=e.message;console.error(e);});



