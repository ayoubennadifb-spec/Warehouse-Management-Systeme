"""Launch Blender rendering and verify the resulting dataset."""
import argparse,os,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--count',type=int,default=20);parser.add_argument('--length-mm',type=float,default=200);parser.add_argument('--width-mm',type=float,default=90);parser.add_argument('--height-mm',type=float,default=90);parser.add_argument('--seed',type=int,default=20261008);parser.add_argument('--backgrounds');args=parser.parse_args()
folder=Path(os.environ.get('ProgramFiles',r'C:\Program Files'))/'Blender Foundation'
choices=sorted(folder.glob('Blender */blender.exe'))
if not choices:raise SystemExit('Blender introuvable. Installez Blender dans son dossier standard.')
from datetime import datetime
output=root/'.local'/('synthetic-containers-'+datetime.now().strftime('%Y%m%d-%H%M%S'))
script=root/'projet_portique_ contenaire_claude/vision/synthetic/generate_blender.py'
command=[str(choices[-1]),'--background','--python',str(script),'--','--output',str(output),'--count',str(args.count),'--seed',str(args.seed),'--length-mm',str(args.length_mm),'--width-mm',str(args.width_mm),'--height-mm',str(args.height_mm)]
if args.backgrounds:command.extend(['--backgrounds',str(Path(args.backgrounds).resolve())])
print('Generation des images, cela peut prendre quelques minutes...',flush=True)
subprocess.run(command,check=True)
subprocess.run([sys.executable,str(script.with_name('verify_dataset.py')),str(output)],check=True)
print('Images et annotations : '+str(output))
