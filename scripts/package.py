"""Build a portable source archive without runtime data or secrets."""
from pathlib import Path
import os
from zipfile import ZipFile, ZIP_DEFLATED
root=Path(__file__).resolve().parents[1]
output=root/'dist'/'portique-lab-source.zip'
exclude={'.git','.openai','.sites-runtime','.venv','.runtime','.local','.backups','node_modules','__pycache__','projet_portique_ contenaire_claude'}
with ZipFile(output,'w',ZIP_DEFLATED) as archive:
    for directory,dirs,files in os.walk(root):
        dirs[:]=sorted(d for d in dirs if d not in exclude)
        for name in sorted(files):
            p=Path(directory)/name
            if p==output or p.name=='.env' or p.suffix=='.pyc':continue
            archive.write(p,Path('portique-lab')/p.relative_to(root))
print(output)
