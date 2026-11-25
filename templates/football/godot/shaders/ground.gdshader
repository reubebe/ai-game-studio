// The level's ground: its colour or tiled texture set, gentle patches of lighter and darker ground,
// and, in web builds, the sun's shadows read from the outline the sun camera draws (sun_shadows.gd).
// The studio's 3D view draws the same patches (level3d.ts, groundPatches): keep the noise in step.
shader_type spatial;

uniform vec4 ground_color : source_color = vec4(0.353, 0.49, 0.235, 1.0);
uniform bool use_texture = false;
uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform bool use_normal = false;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform bool use_roughness = false;
uniform sampler2D roughness_tex : hint_roughness_gray, filter_linear_mipmap_anisotropic, repeat_enable;
// Texture repeats across the plane (its width and depth divided by the tile size).
uniform vec2 uv_scale = vec2(1.0, 1.0);
// 0: one even colour; 1: clear patches of drier and lusher ground.
uniform float variation = 0.0;

// Web builds: the sun's outline picture, the transform into the sun camera, and its size in metres.
uniform bool outline_shadows = false;
uniform sampler2D outline : filter_linear, repeat_disable;
uniform mat4 to_sun;
uniform float extent = 100.0;
uniform float texel = 0.0005;

varying vec3 world_pos;
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

// Patches about 16 m across with smaller ones inside them (0 to 1).
float patches(vec2 xz) {
	vec2 p = xz / 16.0;
	return value_noise(p) * 0.6 + value_noise(p * 2.7 + 7.1) * 0.28 + value_noise(p * 7.3 + 3.7) * 0.12;
}

// Drier (lighter, yellower) and lusher (darker) ground in patches, with a finer mottle up close that
// fades out with distance (far away it would only flicker).
vec3 patchy(vec3 base, vec2 xz, float dist) {
	float n = smoothstep(0.3, 0.7, patches(xz));
	vec3 lush = base * vec3(0.76, 0.88, 0.8);
	vec3 dry = base * vec3(1.32, 1.18, 0.78);
	float mottle = (value_noise(xz / 2.3 + 31.0) - 0.5) * 0.16 * clamp(1.0 - dist / 45.0, 0.0, 1.0);
	return mix(base, mix(lush, dry, n) * (1.0 + mottle), variation);
}

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec2 uv = UV * uv_scale;
	vec3 base = use_texture ? texture(albedo_tex, uv).rgb : ground_color.rgb;
	ALBEDO = variation > 0.0 ? patchy(base, world_pos.xz, length(world_pos - CAMERA_POSITION_WORLD)) : base;
	ROUGHNESS = use_roughness ? texture(roughness_tex, uv).r : 1.0;
	SPECULAR = 0.25;
	if (use_normal) {
		NORMAL_MAP = texture(normal_tex, uv).rgb;
	}
	sun_lit = 1.0;
	if (outline_shadows) {
		vec3 local = (to_sun * vec4(world_pos, 1.0)).xyz;
		vec2 suv = vec2(local.x / extent + 0.5, 0.5 - local.y / extent);
		float covered = 0.0;
		for (int i = -2; i <= 2; i++) {
			for (int j = -2; j <= 2; j++) {
				covered += texture(outline, suv + vec2(float(i), float(j)) * texel).a;
			}
		}
		sun_lit = 1.0 - covered / 25.0;
	}
}

void light() {
	// Lambert diffuse; the sun's share is cut where its outline covers the ground (web builds). In the
	// desktop renderer ATTENUATION carries the sun's real shadow.
	float lit = LIGHT_IS_DIRECTIONAL ? sun_lit : 1.0;
	DIFFUSE_LIGHT += clamp(dot(NORMAL, LIGHT), 0.0, 1.0) * ATTENUATION * lit * LIGHT_COLOR / PI;
}
