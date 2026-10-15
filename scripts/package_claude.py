"""Archive the adopted native Claude app, excluding runtime and credentials."""
from pathlib import Path
import os
from zipfile import ZipFile,ZIP_DEFLATED
root=Path(__file__).resolve().parents[1]
source=root/'projet_portique_ contenaire_claude';output=root/'dist/portique-claude-fusion-source.zip'
with ZipFile(output,'w',ZIP_DEFLATED) as archive:
 for directory,dirs,files in os.walk(source):
  dirs[:]=[d for d in dirs if d not in ('node_modules','.git','__pycache__','.local')]
  for name in files:
   p=Path(directory)/name
   if name=='.env' or p.suffix=='.pyc':continue
   archive.write(p,Path('portique-claude-fusion')/p.relative_to(source))
 archive.write(root/'docs/VERSION_PRINCIPALE.md','portique-claude-fusion/docs/fusion.md')
print(output)
