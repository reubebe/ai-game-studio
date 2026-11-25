// Water: its colour, gently moving ripples that catch the sun, and the sky's colour at a glancing
// view. The studio's 3D view draws water in the same colour without the ripples.
shader_type spatial;
render_mode blend_mix, cull_back, depth_draw_opaque;

uniform vec4 water_color : source_color = vec4(0.184, 0.498, 0.722, 1.0);
uniform vec4 sky_color : source_color = vec4(0.722, 0.831, 0.925, 1.0);

varying vec3 world_pos;

float hash(vec2 p) {
	p = fract(p * vec2(123.34, 456.21));
	p += dot(p, p + 45.32);
	return fract(p.x * p.y);
}

float value_noise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	float a = hash(i);
	float b = hash(i + vec2(1.0, 0.0));
	float c = hash(i + vec2(0.0, 1.0));
	float d = hash(i + vec2(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float waves(vec2 xz, float t) {
	return value_noise(xz * 0.8 + vec2(t * 0.22, t * 0.15)) * 0.6 + value_noise(xz * 1.9 - vec2(t * 0.17, -t * 0.26)) * 0.4;
}

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	float e = 0.08;
	float hx = waves(world_pos.xz + vec2(e, 0.0), TIME) - waves(world_pos.xz - vec2(e, 0.0), TIME);
	float hz = waves(world_pos.xz + vec2(0.0, e), TIME) - waves(world_pos.xz - vec2(0.0, e), TIME);
	vec3 n = normalize(vec3(-hx * 1.6, 1.0, -hz * 1.6));
	NORMAL = normalize((VIEW_MATRIX * vec4(n, 0.0)).xyz);
	float facing = clamp(dot(NORMAL, VIEW), 0.0, 1.0);
	float glance = pow(1.0 - facing, 3.0);
	ALBEDO = mix(water_color.rgb, sky_color.rgb, glance * 0.7);
	ROUGHNESS = 0.06;
	SPECULAR = 0.7;
	ALPHA = mix(0.8, 0.96, glance);
}
