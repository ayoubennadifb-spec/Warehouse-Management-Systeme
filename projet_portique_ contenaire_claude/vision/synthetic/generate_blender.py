"""Run with Blender --background --python this_file -- --output PATH --count 20.
Outputs YOLO pose labels, metadata and preview .blend; units are metres.
"""
import argparse,json,math,random,sys,colorsys
from pathlib import Path
import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

parser=argparse.ArgumentParser()
parser.add_argument('--output',required=True)
parser.add_argument('--count',type=int,default=20)
parser.add_argument('--seed',type=int,default=20261008)
parser.add_argument('--length-mm',type=float,default=200)
parser.add_argument('--width-mm',type=float,default=90)
parser.add_argument('--height-mm',type=float,default=90)
parser.add_argument('--samples',type=int,default=8)
parser.add_argument('--backgrounds',help='Optional folder containing empty floor JPG/PNG textures')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
if args.count<1 or min(args.length_mm,args.width_mm,args.height_mm)<=0:parser.error('Dimensions et nombre positifs requis.')
output=Path(args.output).resolve();output.mkdir(parents=True,exist_ok=True)
L,W,H=[v/1000 for v in (args.length_mm,args.width_mm,args.height_mm)]
scene=bpy.context.scene
scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=args.samples
scene.cycles.use_denoising=True
scene.render.resolution_x=640;scene.render.resolution_y=480;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.world.color=(.3,.3,.3)
scene.view_settings.view_transform='AgX'
scene.render.film_transparent=False
random.seed(args.seed)


def material(name,color,roughness=.65):
    mat=bpy.data.materials.new(name);mat.diffuse_color=(*color,1);mat.use_nodes=True
    bsdf=mat.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Base Color'].default_value=(*color,1);bsdf.inputs['Roughness'].default_value=roughness
    return mat


def cube(name,size,location,color,yaw=0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=location)
    obj=bpy.context.object;obj.name=name;obj.dimensions=size;obj.rotation_euler[2]=yaw
    obj.data.materials.append(material(name+' paint',color,random.uniform(.45,.85)))
    return obj


def project(point,camera):
    p=world_to_camera_view(scene,camera,point)
    return [float(p.x),float(1-p.y),float(p.z)]


def visible(point,obj,camera):
    origin=camera.matrix_world.translation
    direction=point-origin;distance=direction.length
    hit,location,_,_,found,_=scene.ray_cast(bpy.context.evaluated_depsgraph_get(),origin,direction.normalized(),distance=distance+.002)
    return hit and found.original==obj.original and (location-point).length<.002


def annotate(obj,camera,level):
    full=[obj.matrix_world@Vector(v) for v in obj.bound_box]
    projected=[project(v,camera) for v in full]
    if any(p[2]<=0 for p in projected):return None
    uv=[p[:2] for p in projected];xs=[p[0] for p in uv];ys=[p[1] for p in uv]
    # Exclude cut objects from this starter dataset: all object corners must fit.
    if min(xs)<.01 or max(xs)>.99 or min(ys)<.01 or max(ys)>.99:return None
    top=[Vector((-.5,-.5,.5)),Vector((.5,-.5,.5)),Vector((.5,.5,.5)),Vector((-.5,.5,.5))]
    center2=sum((Vector(project(obj.matrix_world@p,camera)[:2]) for p in top),Vector((0,0)))/4
    top.sort(key=lambda p:math.atan2(project(obj.matrix_world@p,camera)[1]-center2.y,project(obj.matrix_world@p,camera)[0]-center2.x))
    first=min(range(4),key=lambda i:(project(obj.matrix_world@top[i],camera)[1],project(obj.matrix_world@top[i],camera)[0]))
    top=top[first:]+top[:first]
    points=[];metadata=[]
    for local in top:
        point=obj.matrix_world@local
        # Test just inside the top face to avoid edge precision ambiguity.
        interior=obj.matrix_world@Vector((local.x*.998,local.y*.998,local.z))
        u,v,_=project(point,camera);seen=visible(interior,obj,camera)
        # v=0 excludes hidden corners from loss; retain exact 3D truth in JSON.
        points.extend([u,v,2] if seen else [0,0,0])
        metadata.append(dict(pixel=[u*640,v*480],visible=bool(seen),world_mm=[round(float(c)*1000,4) for c in point]))
    # Keep side-visible lower containers even when their top is hidden.
    center=obj.matrix_world.translation
    surface_probes=[obj.matrix_world@Vector(p) for p in [(0,0,.5),(.5,0,0),(-.5,0,0),(0,.5,0),(0,-.5,0)]]
    if not any(visible(p,obj,camera) for p in surface_probes):return None
    x1,x2=min(xs),max(xs);y1,y2=min(ys),max(ys)
    values=[0,(x1+x2)/2,(y1+y2)/2,x2-x1,y2-y1,*points]
    return ' '.join(str(round(v,7)) for v in values),dict(name=obj.name,level=level,center_mm=[round(float(v)*1000,3) for v in center],bbox_normalized=[(x1+x2)/2,(y1+y2)/2,x2-x1,y2-y1],top_corners=metadata)


def varied_material(obj,rng,kind):
    mat=obj.data.materials[0];nodes=mat.node_tree.nodes;links=mat.node_tree.links
    shader=nodes.get('Principled BSDF')
    texcoord=nodes.new('ShaderNodeTexCoord')
    texture_files=[]
    if args.backgrounds:
        texture_files=[p for p in Path(args.backgrounds).glob('*') if p.suffix.lower() in ('.png','.jpg','.jpeg')]
    if kind=='photo' and texture_files:
        texture=nodes.new('ShaderNodeTexImage');texture.image=bpy.data.images.load(str(rng.choice(texture_files)),check_existing=True)
        links.new(texcoord.outputs['UV'],texture.inputs['Vector']);links.new(texture.outputs['Color'],shader.inputs['Base Color'])
        return
    texture=nodes.new('ShaderNodeTexChecker' if kind=='checker' else 'ShaderNodeTexNoise')
    links.new(texcoord.outputs['Generated'],texture.inputs['Vector'])
    texture.inputs['Scale'].default_value=rng.uniform(4,12) if kind=='checker' else rng.uniform(20,90) if kind=='concrete' else rng.uniform(3,12)
    base=tuple(mat.diffuse_color[:3])
    if kind=='checker':
        texture.inputs['Color1'].default_value=(*base,1)
        texture.inputs['Color2'].default_value=(*[min(1,c*rng.uniform(.4,1.7)) for c in base],1)
        links.new(texture.outputs['Color'],shader.inputs['Base Color'])
    else:
        ramp=nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].color=(*[c*.65 for c in base],1)
        ramp.color_ramp.elements[1].color=(*[min(1,c*1.25+.01) for c in base],1)
        links.new(texture.outputs['Fac'],ramp.inputs['Fac']);links.new(ramp.outputs['Color'],shader.inputs['Base Color'])
        bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.12;bump.inputs['Distance'].default_value=.0003
        links.new(texture.outputs['Fac'],bump.inputs['Height']);links.new(bump.outputs['Normal'],shader.inputs['Normal'])


palette=[(.55,.025,.018),(.018,.12,.55),(.025,.3,.07),(.48,.3,.025),(.2,.2,.22)]
manifest=[]
for index in range(args.count):
    rng=random.Random(args.seed+index);random.seed(args.seed+index)
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    for mat in list(bpy.data.materials):
        if mat.users==0:bpy.data.materials.remove(mat)
    scene.view_settings.exposure=rng.uniform(-1.5,.35)
    scene.world.use_nodes=True
    ambient=scene.world.node_tree.nodes.get('Background');ambient.inputs['Strength'].default_value=rng.uniform(.08,.7)
    ambient.inputs['Color'].default_value=(.7,.8,1,1) if rng.random()<.5 else (1,.85,.65,1)
    background_kind=rng.choice(['concrete','noise','checker','photo' if args.backgrounds else 'noise'])
    floor_color=colorsys.hsv_to_rgb(rng.random(),rng.uniform(0,.35),rng.uniform(.12,.65))
    floor=cube('Plateau',(1,.75,.015),(0,0,-.0075),floor_color)
    varied_material(floor,rng,background_kind)
    objects=[]
    mode=index%5
    cells=[(-.27,-.15),(0,-.15),(.27,-.15),(-.27,.15),(0,.15),(.27,.15)]
    rng.shuffle(cells)
    groups=1 if mode in (0,1) else rng.randint(2,5)
    if mode==4:groups=0 # Empty scenes are intentional negatives.
    for group,(cx,cy) in enumerate(cells[:groups]):
        cx+=rng.uniform(-.01,.01);cy+=rng.uniform(-.01,.01)
        yaw=rng.uniform(-math.pi,math.pi)
        stack=rng.randint(2,3) if mode==3 else 1
        for level in range(1,stack+1):
            color=rng.choice(palette) if rng.random()<.5 else colorsys.hsv_to_rgb(rng.random(),rng.uniform(.05,.95),rng.uniform(.12,.65))
            obj=cube('Container_%02d_%d'%(group,level),(L,W,H),(cx,cy,H*(level-.5)),color,yaw)
            varied_material(obj,rng,'noise')
            objects.append((obj,level))
    bpy.ops.object.camera_add(location=(rng.uniform(-.08,.08),rng.uniform(-.1,.1) if mode==0 else rng.uniform(-.55,-.25),rng.uniform(1.05,1.3)))
    camera=bpy.context.object;camera.name='Camera_phone';camera.data.lens=rng.uniform(32,38);camera.data.sensor_width=36
    direction=Vector((0,0,.1))-camera.location
    camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler();scene.camera=camera
    bpy.ops.object.light_add(type='AREA',location=(rng.uniform(-.6,.6),rng.uniform(-.5,.5),1.4))
    lamp=bpy.context.object;lamp.data.energy=rng.uniform(8,60);lamp.data.color=rng.choice([(1,.72,.48),(.65,.8,1),(1,1,1)]);lamp.data.shape='DISK';lamp.data.size=rng.uniform(.15,1.1)
    lamp.rotation_euler=(Vector((0,0,0))-lamp.location).to_track_quat('-Z','Y').to_euler()
    # Keep every rendered object inside the camera so no visible box is unlabelled.
    for retry in range(12):
        bpy.context.view_layer.update()
        points=[project(obj.matrix_world@Vector(v),camera) for obj,_ in objects for v in obj.bound_box]
        if all(p[2]>0 and .025<=p[0]<=.975 and .025<=p[1]<=.975 for p in points):break
        camera.location.z+=.1
        camera.rotation_euler=(Vector((0,0,.1))-camera.location).to_track_quat('-Z','Y').to_euler()
    else:raise ValueError('Unable to frame all containers. Adjust positions or camera.')
    bpy.context.view_layer.update()
    split='val' if index%4==0 else 'train'
    # Ensure negative and multi-object scenes in both splits for a full batch.
    name='synthetic_%04d'%index
    for folder in ['images','labels','metadata']:(output/folder/split).mkdir(parents=True,exist_ok=True)
    labels=[];truth=[]
    for obj,level in objects:
        result=annotate(obj,camera,level)
        if result:labels.append(result[0]);truth.append(result[1])
    scene.render.filepath=str(output/'images'/split/(name+'.png'))
    bpy.ops.render.render(write_still=True)
    (output/'labels'/split/(name+'.txt')).write_text('\n'.join(labels)+('\n' if labels else ''),encoding='utf-8')
    data=dict(synthetic=True,background=background_kind,exposure=scene.view_settings.exposure,light_energy=lamp.data.energy,light_color=list(lamp.data.color),light_size=lamp.data.size,camera_lens=camera.data.lens,seed=args.seed+index,dimensions_mm=[args.length_mm,args.width_mm,args.height_mm],resolution=[640,480],camera_matrix_world=[list(row) for row in camera.matrix_world],objects=truth,scene_object_count=len(objects),labelled_count=len(labels))
    (output/'metadata'/split/(name+'.json')).write_text(json.dumps(data,indent=2),encoding='utf-8')
    manifest.append(dict(image=str(Path('images')/split/(name+'.png')),split=split,objects=len(labels)))
    if index==3:bpy.ops.wm.save_as_mainfile(filepath=str(output/'preview_scene.blend'))
    print('SYNTHETIC_PROGRESS %d/%d objects=%d'%(index+1,args.count,len(labels)),flush=True)
(output/'manifest.json').write_text(json.dumps(dict(synthetic=True,dimensions_mm=[args.length_mm,args.width_mm,args.height_mm],images=manifest),indent=2),encoding='utf-8')
(output/'container-pose.yaml').write_text('path: '+json.dumps(str(output))+'\ntrain: images/train\nval: images/val\nnames:\n  0: container\nkpt_shape: [4, 3]\n',encoding='utf-8')
print('SYNTHETIC_DONE '+str(output),flush=True)
