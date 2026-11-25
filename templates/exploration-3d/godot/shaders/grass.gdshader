// Tufts of grass (grass.gd places them): coloured like the ground under them (ground.gdshader's
// patches), swaying in the wind, shrinking away into the ground far off, and in shade where the sun's
// shadow falls (the outline in web builds, real shadows on the desktop).
shader_type spatial;
render_mode cull_disabled;

uniform vec4 ground_color : source_color = vec4(0.353, 0.49, 0.235, 1.0);
uniform float variation = 0.0;
// Grass shrinks into the ground between these distances from the camera (metres).
uniform float fade_start = 30.0;
uniform float fade_end = 42.0;

uniform bool outline_shadows = false;
uniform sampler2D outline : filter_linear, repeat_disable;
uniform mat4 to_sun;
uniform float extent = 100.0;
uniform float texel = 0.0005;
// 1 in the anime style: shadows end in a crisp line instead of a soft edge.
uniform float crisp = 0.0;

varying vec3 world_pos;
varying vec3 tuft_pos;
varying float sun_lit;

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

float patches(vec2 xz) {
	vec2 p = xz / 16.0;
	return value_noise(p) * 0.6 + value_noise(p * 2.7 + 7.1) * 0.28 + value_noise(p * 7.3 + 3.7) * 0.12;
}

void vertex() {
	tuft_pos = (MODEL_MATRIX * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
	float dist = length(tuft_pos - CAMERA_POSITION_WORLD);
	float keep = 1.0 - smoothstep(fade_start, fade_end, dist);
	// UV.y runs from the blade's foot (0) to its tip (1); only the upper part bends.
	float bend = UV.y * UV.y;
	float phase = TIME * 1.6 + dot(tuft_pos.xz, vec2(0.21, 0.17));
	VERTEX.x += (sin(phase) * 0.6 + sin(phase * 2.3 + 1.7) * 0.25) * 0.07 * bend;
	VERTEX.z += sin(phase * 0.8 + 0.9) * 0.05 * bend;
	VERTEX *= keep;
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	float n = smoothstep(0.3, 0.7, patches(tuft_pos.xz));
	vec3 base = ground_color.rgb;
	vec3 lush = base * vec3(0.76, 0.88, 0.8);
	vec3 dry = base * vec3(1.32, 1.18, 0.78);
	vec3 under = mix(base, mix(lush, dry, n), variation);
	// Darker at the foot, lighter and a little yellower at the tip; each tuft a shade different.
	float shade = 0.9 + hash(tuft_pos.xz * 0.37) * 0.22;
	ALBEDO = mix(under * 0.62, under * vec3(1.28, 1.24, 0.98), UV.y) * shade;
	ROUGHNESS = 0.9;
	SPECULAR = 0.2;
	// Lit like the ground it grows from, so the field does not sparkle as blades turn.
	NORMAL = normalize((VIEW_MATRIX * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
	sun_lit = 1.0;
	if (outline_shadows) {
		vec3 local = (to_sun * vec4(world_pos, 1.0)).xyz;
		vec2 suv = vec2(local.x / extent + 0.5, 0.5 - local.y / extent);
		float covered = 0.0;
		for (int i = -1; i <= 1; i++) {
			for (int j = -1; j <= 1; j++) {
				covered += texture(outline, suv + vec2(float(i), float(j)) * texel * 2.0).a;
			}
		}
		covered /= 9.0;
		sun_lit = 1.0 - mix(covered, smoothstep(0.3, 0.7, covered), crisp);
	}
}

void light() {
	float lit = LIGHT_IS_DIRECTIONAL ? sun_lit : 1.0;
	DIFFUSE_LIGHT += clamp(dot(NORMAL, LIGHT), 0.0, 1.0) * ATTENUATION * lit * LIGHT_COLOR / PI;
}
