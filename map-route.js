// Connect every published capture in sequence within its recording.
function segmentError(p,a,b){
 const scale=Math.cos(a.lat*Math.PI/180),x=(p.lon-a.lon)*scale*111320,y=(p.lat-a.lat)*111320;
 const dx=(b.lon-a.lon)*scale*111320,dy=(b.lat-a.lat)*111320;
 const t=dx*dx+dy*dy?Math.max(0,Math.min(1,(x*dx+y*dy)/(dx*dx+dy*dy))):0;
 return Math.hypot(x-t*dx,y-t*dy);
}
export function simplifyTrack(points,tolerance=4){
 if(points.length<=2)return points.slice();
 const keep=new Set([0,points.length-1]),stack=[[0,points.length-1]];
 while(stack.length){const [a,b]=stack.pop();let max=tolerance,index=-1;for(let i=a+1;i<b;i++){const e=segmentError(points[i],points[a],points[b]);if(e>max){max=e;index=i;}}if(index>=0){keep.add(index);stack.push([a,index],[index,b]);}}
 return [...keep].sort((a,b)=>a-b).map(i=>points[i]);
}
export function displayTracks(navigation){return navigation.sections.map(section=>{const raw=[...section.stops].sort((a,b)=>a.seq-b.seq);return {segmentId:raw[0].segmentId,raw,points:raw.slice()};});}
export function needsRecenter(point,size){return point.x<size.x*.2||point.x>size.x*.8||point.y<size.y*.2||point.y>size.y*.8;}
