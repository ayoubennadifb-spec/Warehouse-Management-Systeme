"""Recover visible cuboid faces from existing Blender metadata, with a depth buffer.

Only valid for the original opaque cuboid generator (36 mm camera sensor).
Pixel projection is checked against all recorded top corners before use.
"""
import cv2
import numpy as np

CLASSES = {0: 'top', 1: 'long_side', 2: 'short_side'}

def project(world, metadata):
    world = np.asarray(world, np.float64).reshape(-1, 3)
    camera = np.array(metadata['camera_matrix_world'], np.float64)
    points = np.c_[world / 1000, np.ones(len(world))] @ np.linalg.inv(camera).T
    depth = -points[:, 2]
    width, height = metadata['resolution']
    focal = metadata['camera_lens'] / 36 * width
    assert (depth > 0).all(), 'Face behind camera'
    pixels = np.c_[width / 2 + focal * points[:, 0] / depth,
                   height / 2 - focal * points[:, 1] / depth]
    return pixels, depth

def raster_triangle(points, depth, face_id, zbuffer, ids):
    height, width = ids.shape
    lo = np.maximum(0, np.floor(points.min(axis=0)).astype(int))
    hi = np.minimum([width-1, height-1], np.ceil(points.max(axis=0)).astype(int))
    if (hi < lo).any(): return
    xx, yy = np.meshgrid(np.arange(lo[0], hi[0]+1)+.5, np.arange(lo[1], hi[1]+1)+.5)
    a,b,c = points
    denominator = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
    if abs(denominator) < 1e-9: return
    u = ((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/denominator
    v = ((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/denominator
    w = 1-u-v
    inside = (u >= -1e-8)&(v >= -1e-8)&(w >= -1e-8)
    inverse_depth = u/depth[0]+v/depth[1]+w/depth[2]
    candidate = np.divide(1, inverse_depth, out=np.full_like(inverse_depth,np.inf), where=inverse_depth>0)
    region = np.s_[lo[1]:hi[1]+1, lo[0]:hi[0]+1]
    replace = inside & (candidate < zbuffer[region])
    zbuffer[region][replace] = candidate[replace]
    ids[region][replace] = face_id

def visible_faces(metadata):
    width,height = metadata['resolution']
    camera_center = np.array(metadata['camera_matrix_world'])[:3,3]*1000
    ids = np.zeros((height,width),np.int32)
    zbuffer = np.full((height,width),np.inf)
    faces=[]; projection_errors=[]
    for obj in metadata['objects']:
        top = np.array([c['world_mm'] for c in obj['top_corners']],np.float64)
        reference = np.array([c['pixel'] for c in obj['top_corners']],np.float64)
        actual,_ = project(top,metadata)
        projection_errors.extend(np.linalg.norm(actual-reference,axis=1).tolist())
        bottom = top - [0,0,metadata['dimensions_mm'][2]]
        center = np.array(obj['center_mm'])
        candidates=[(0,top)]
        for i in range(4):
            j=(i+1)%4
            edge = np.linalg.norm(top[j]-top[i])
            kind = 1 if abs(edge-metadata['dimensions_mm'][0]) < abs(edge-metadata['dimensions_mm'][1]) else 2
            candidates.append((kind,np.array([top[i],bottom[i],bottom[j],top[j]])))
        for kind,world in candidates:
            normal=np.cross(world[1]-world[0],world[2]-world[0])
            face_center=world.mean(axis=0)
            if np.dot(normal,face_center-center)<0:normal=-normal
            if np.dot(normal,camera_center-face_center)<=0:continue
            pixels,depth=project(world,metadata)
            face_id=len(faces)+1
            faces.append(dict(id=face_id,kind=kind,object=obj['name'],polygon=pixels.tolist()))
            for triangle in ([0,1,2],[0,2,3]):
                raster_triangle(pixels[triangle],depth[triangle],face_id,zbuffer,ids)
    max_error=max(projection_errors,default=0)
    assert max_error < .05, f'Camera projection mismatch: {max_error:.3f} px'
    return ids,faces,max_error

def polygon_label(mask, tolerance=.98):
    contours,hierarchy=cv2.findContours(mask.astype(np.uint8),cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    external=[c for i,c in enumerate(contours) if hierarchy[0,i,3]<0]
    if not external:return None,'empty mask'
    # Subpixel seams can produce tiny islands/holes. Accept a single polygon only
    # if its reconstruction still agrees with >=98% of the original mask.
    contour=max(external,key=cv2.contourArea)
    polygon=cv2.approxPolyDP(contour,.4,True).reshape(-1,2)
    if len(polygon)<3:return None,'degenerate polygon'
    reconstructed=np.zeros_like(mask,dtype=np.uint8)
    cv2.fillPoly(reconstructed,[polygon],1)
    iou=np.logical_and(mask,reconstructed).sum()/max(1,np.logical_or(mask,reconstructed).sum())
    if iou<tolerance:return None,f'polygon fidelity {iou:.4f}'
    return polygon,None
