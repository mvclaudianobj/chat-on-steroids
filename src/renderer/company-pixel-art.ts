/**
 * Adapted from the procedural pixel-art approach in Habblaud's client/src/art
 * (MIT, Copyright (c) 2026 Márcio Junior). These compact stamps and furniture
 * layouts are tailored to Company tickets; no live activity is inferred here.
 * Original license: src/renderer/company-assets/LICENSE.md.
 */
type RoomArt = 'project' | 'department' | 'rest' | 'meeting' | 'attention' | 'offline' | 'garden';
type Brush = CanvasRenderingContext2D;
const colors = ['#d8b18d','#8f5e4a','#d69b6c','#9b6945','#d5c2a2','#70554b'];
const coats = ['#4e83a6','#9871ab','#508e82','#ba7d50','#537eac','#ae5c73'];

/** A tiny ASCII pixel stamp is the same fundamental rendering primitive as
 * Habblaud PixelBuf.stamp. Render only on model state changes. */
function stamp(ctx: Brush, rows: string[], ox: number, oy: number, palette: Record<string,string>): void {
  rows.forEach((row,y)=>{ for(let x=0;x<row.length;x++){const color=palette[row[x]!] ;if(!color)continue;
    ctx.fillStyle=color;ctx.fillRect(ox+x,oy+y,1,1);
  } });
}
const hair=[
  '......hhhh......',
  '.....hhhhhh.....',
  '....hhhhhhhh....',
  '....hhhhhhhh....',
  '...hhhhhhhhhh...',
  '...hssssssssh...',
  '...hssssssssh...',
  '....sEssssEs....',
  '....ssssssss....',
  '.....ssssss.....',
  '......ssss......'
];
const torso=[
  '......ccccc.....',
  '.....ccccccc....',
  '....ccccccccc...',
  '...scccccccccs..',
  '...scccccccccs..',
  '...scccccccccs..',
  '....ccccccccc...',
  '....ccccccccc...',
  '.....bbbbbbb....',
  '.....bbbbbbb....',
  '.....bbbbbbb....',
  '.....bbb.bbb....',
  '.....bbb.bbb....',
  '.....bbb.bbb....',
  '.....kkk.kkk....',
  '.....kkk.kkk....'
];
export function paintCompanyCharacter(canvas: HTMLCanvasElement, seed: number): void {
  if (canvas.ownerDocument.defaultView?.navigator.userAgent.includes('jsdom')) return;
  const ctx=canvas.getContext('2d');if(!ctx)return;
  canvas.width=24;canvas.height=34;ctx.clearRect(0,0,24,34);
  const skin=colors[seed%colors.length]!, coat=coats[seed%coats.length]!;
  const palette={h:seed%3===0?'#3f3444':seed%3===1?'#8a5536':'#bb8a50',
    s:skin,E:'#293a49',c:coat,b:'#303e65',k:'#332f42'};
  ctx.fillStyle='#18243e55';ctx.fillRect(3,31,17,2);
  stamp(ctx,hair,4,2,palette);stamp(ctx,torso,4,13,palette);
  ctx.fillStyle='#ffffff80';ctx.fillRect(11,15,1,3);
}
function block(ctx: Brush,x:number,y:number,w:number,h:number,c:string):void{ctx.fillStyle=c;ctx.fillRect(x,y,w,h);}
function furniture(ctx: Brush,x:number,y:number,shade:string):void{
  // Chibi desks, screens, keyboards and chair silhouettes.
  block(ctx,x-5,y+12,58,7,'#413a4a');block(ctx,x,y,46,16,'#a66f56');
  block(ctx,x+3,y+3,40,7,'#d2a07d');block(ctx,x+9,y-25,31,29,'#303c50');
  block(ctx,x+12,y-22,25,18,shade);block(ctx,x+21,y+4,9,2,'#f4d7ae');
  block(ctx,x+1,y+16,5,18,'#5d4350');block(ctx,x+40,y+16,5,18,'#5d4350');
  block(ctx,x+17,y+20,12,6,'#5a6172');
}
function plant(ctx: Brush,x:number,y:number):void{
  block(ctx,x-7,y-1,15,15,'#a86f61');block(ctx,x-9,y-5,19,5,'#d1976b');
  block(ctx,x-2,y-32,4,28,'#52704f');
  for(const [dx,dy] of [[-13,-26],[8,-28],[-9,-39],[6,-42],[-3,-47]] as const) {
    block(ctx,x+dx,y+dy,13,9,'#4a805d');block(ctx,x+dx+3,y+dy+2,5,4,'#79a678');
  }
}
/**
 * Furniture and floor tiles follow Habblaud's 16x12 project-room vocabulary,
 * but are drawn from a deliberately small palette for an event-driven DOM map.
 */
export function paintCompanyRoom(canvas:HTMLCanvasElement,kind:RoomArt,seed=0):void{
  if(canvas.ownerDocument.defaultView?.navigator.userAgent.includes('jsdom'))return;
  const ctx=canvas.getContext('2d');if(!ctx)return;
  canvas.width=384;canvas.height=180;ctx.imageSmoothingEnabled=false;
  block(ctx,0,0,384,180,kind==='garden'?'#466b56':'#dac6a4');
  if(kind==='garden'){
    for(let y=0;y<180;y+=16)for(let x=0;x<384;x+=16)block(ctx,x,y,15,15,(x+y)%48===0?'#709a69':'#60885e');
    for(let x=29;x<384;x+=62)plant(ctx,x,120+(x%3)*11);
    for(let x=8;x<384;x+=36){block(ctx,x,145+(x%4)*3,4,4,'#ffd690');block(ctx,x+5,148,3,3,'#e2a2ac');}
    return;
  }
  block(ctx,0,0,384,43,'#7b93a5');block(ctx,0,36,384,8,'#43576c');
  for(let y=44;y<180;y+=18)for(let x=0;x<384;x+=24){
    block(ctx,x,y,23,17,(Math.floor(x/24)+Math.floor(y/18))%2===0?'#cba984':'#d9b892');
  }
  for(let x=16;x<368;x+=118){block(ctx,x,8,46,26,'#394d68');block(ctx,x+4,11,38,18,'#9cbac2');
    block(ctx,x+5,23,36,5,'#b7d3d3');block(ctx,x+21,12,3,17,'#f3e7cc');}
  block(ctx,0,172,384,8,'#927456');
  if(kind==='project'||kind==='department'||kind==='attention'||kind==='offline'){
    const a=seed%3; furniture(ctx,27,98,a===0?'#6daeb5':a===1?'#987ab4':'#c68a6a');
    furniture(ctx,159,98,a===0?'#bc82ad':a===1?'#84afb6':'#879ed0');
    furniture(ctx,284,98,a===0?'#a0b9bd':a===1?'#cd987b':'#b2a3c9');
    plant(ctx,363,151);plant(ctx,12,155);
    block(ctx,120,40,44,30,'#b0c2cb');block(ctx,123,43,38,24,'#3b6472');
    block(ctx,134,51,17,6,'#a2c5c7');
  }else if(kind==='meeting'){
    block(ctx,70,108,248,39,'#624a52');block(ctx,77,101,235,33,'#d1a678');
    for(let x=95;x<310;x+=45){block(ctx,x,91,23,10,'#4a6077');block(ctx,x,144,23,10,'#4a6077');}
    block(ctx,153,7,86,33,'#334e63');block(ctx,157,12,78,23,'#9ab9b8');
    plant(ctx,350,151);
  }else if(kind==='rest'){
    block(ctx,51,117,120,30,'#566c87');block(ctx,40,101,24,44,'#819bb6');
    block(ctx,167,101,24,44,'#819bb6');block(ctx,223,108,116,20,'#906951');
    block(ctx,228,95,109,13,'#c39d78');block(ctx,254,85,23,11,'#e5c4a2');
    plant(ctx,345,154);
  }
}
