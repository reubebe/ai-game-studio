// Ink outlines for the anime style (style.gd): a slightly larger copy of each surface drawn from the
// inside in the ink colour, so only its rim shows around the object (an "inverted hull"). The width
// grows with distance so lines keep about the same thickness on screen. The studio's 3D view draws
// outlines the same way (level3d.ts, outlines).
shader_type spatial;
render_mode unshaded, cull_front, shadows_disabled;

uniform vec4 ink : source_color = vec4(0.1, 0.08, 0.13, 1.0);
// Line width in metres for something 6 m from the camera.
uniform float width = 0.022;

void vertex() {
	// Grow along the normal in world space, then back into the mesh's own space: parts scaled unevenly
	// (a squashed sphere for a beetle's shell) keep an even line.
	vec3 world = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	float dist = length(world - CAMERA_POSITION_WORLD);
	vec3 grow = normalize(MODEL_NORMAL_MATRIX * NORMAL) * width * clamp(dist / 6.0, 0.5, 4.0);
	VERTEX += inverse(mat3(MODEL_MATRIX)) * grow;
}

void fragment() {
	ALBEDO = ink.rgb;
}
