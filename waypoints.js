import {stationStyle} from './route-style.js';
import {bearing,distance,wrap} from './navigation.js';
const coord=p=>({lat:p.lat??p.y,lon:p.lon??p.x});
export const range=(a,b)=>distance(coord(a),coord(b));
export const rangeLabel=m=>m<1000?`${Math.round(m)} m`:`${(m/1000).toFixed(1)} km`;
export function photoGroups(photos){
 const groups=[];
 for(const p of photos){let g=groups.find(g=>range(g,p)<=80);if(!g){g={id:`photos-${p.OBJECTID}`,...coord(p),photos:[]};groups.push(g);}g.photos.push(p);}
 return groups;
}
export function panoramaPoints(station,groups,gauges){
 const near=groups.map(g=>({...g,kind:'photo',meters:range(station,g)})).sort((a,b)=>a.meters-b.meters);
 const photos=near.filter((g,i)=>g.meters<=1500||i===0).slice(0,6);
 const points=[...photos,...gauges.map(g=>({...g,...coord(g),id:g.StationID,kind:'gauge',meters:range(station,g)}))].map(p=>({...p,yaw:wrap(bearing(coord(station),p)-station.heading),pitch:p.meters<80?-Math.min(5,Math.atan2(2.2,Math.max(3,p.meters))*180/Math.PI):-.5}));
 // Stack labels that point in similar directions. Their vertical lane is a UI
 // layout choice, not a surveyed elevation or a visibility assertion.
 const placed=[];
 for(const p of points){for(const lane of [p.pitch,-15,-30,15,30,-45,45,-60,60]){if(!placed.some(q=>Math.abs(wrap(q.yaw-p.yaw))<35&&Math.abs(q.pitch-lane)<13)){p.pitch=lane;break;}}placed.push(p);}
 return points;
}
export function installWaypoints(catalog,{onPhotoGroup,onGauge}){
 const groups=photoGroups(catalog.phone),api=window.buffalo,map=api.map;
 const photos=L.layerGroup(),gauges=L.layerGroup();
 const markers=[];
 function add(p,layer,label){
  const icon=L.divIcon({className:'map-waypoint original-photo',html:'<img src="assets/phone-photo.png" alt="">',iconSize:[20,20],iconAnchor:[10,10]});
  const marker=(p.kind==='photo'?L.marker([p.lat,p.lon],{icon,title:label,keyboard:true}):L.circleMarker([p.lat,p.lon],{radius:stationStyle.radius,color:stationStyle.outline,weight:stationStyle.weight,fillColor:stationStyle.color,fillOpacity:1})).addTo(layer).bindTooltip(label);
  if(p.kind==='gauge')marker.on('add',()=>{const el=marker.getElement();el?.setAttribute('tabindex','0');el?.setAttribute('role','button');el?.setAttribute('aria-label',label);if(el)el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();marker.fire('click');}};});
  marker.on('click',()=>{for(const m of markers)m.getElement()?.classList.toggle('chosen-waypoint',m===marker);p.kind==='photo'?onPhotoGroup(p):onGauge(p);});markers.push(marker);
 }
 for(const g of groups)add({...g,kind:'photo'},photos,g.photos.length+' field photos');
 for(const g of catalog.stations)add({...g,...coord(g),kind:'gauge'},gauges,g.Name);
 const legend=document.createElement('div');legend.className='map-location-tools';legend.innerHTML='<span><i class="june-dot"></i> June 3</span><span><i class="august-dot"></i> August 31</span><span><i class="photo-dot"></i> Photos</span><span><i class="gauge-dot"></i> River stations</span><button id="all-locations">Show all locations</button>';document.querySelector('#map-panel').insertBefore(legend,document.querySelector('#map'));
 function routeOverview(){map.invalidateSize();map.fitBounds(L.latLngBounds(api.stations.map(p=>[p.lat,p.lon])),{padding:[6,6],animate:false});}
 function overview(){map.invalidateSize();map.fitBounds(L.latLngBounds([...api.stations,...groups,...catalog.stations.map(coord)].map(p=>[p.lat,p.lon])),{padding:[26,26],animate:false});}
 document.querySelector('#all-locations').onclick=overview;
 // Supporting information belongs to the records tab, never over the panorama.
 window.buffaloWaypoints=()=>[];api.refreshWaypoints();
 let records=false;
 function setRecordsMode(on){if(on===records)return;records=on;if(on){photos.addTo(map);gauges.addTo(map);routeOverview();requestAnimationFrame(routeOverview);}else{map.removeLayer(photos);map.removeLayer(gauges);}map.invalidateSize();}
 return {groups,setRecordsMode};
}
