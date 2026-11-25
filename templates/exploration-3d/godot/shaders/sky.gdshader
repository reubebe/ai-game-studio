// The sky: the gradient and sun of Godot's ProceduralSkyMaterial (Godot Engine, MIT licence), with
// clouds added. The studio's 3D view draws the same sky (level3d.ts, SKY_SHADER): keep the cloud noise
// and colours in step.
shader_type sky;
render_mode use_debanding;

uniform vec4 sky_top_color : source_color = vec4(0.184, 0.388, 0.659, 1.0);
uniform vec4 sky_horizon_color : source_color = vec4(0.722, 0.831, 0.925, 1.0);
uniform vec4 ground_bottom_color : source_color = vec4(0.2, 0.25, 0.18, 1.0);
uniform vec4 ground_horizon_color : source_color = vec4(0.722, 0.831, 0.925, 1.0);
// 0: a clear sky; 1: overcast.
uniform float clouds = 0.0;
// Moves the clouds' pattern, so levels need not share one.
uniform vec2 cloud_offset = vec2(0.0, 0.0);
// 0: soft clouds; 1: the anime style's crisp clouds in two tones, white and a light shade of the sky.
uniform float anime = 0.0;

const float INV_SKY_CURVE = 4.0;      // 0.6 / sky_curve 0.15
const float INV_GROUND_CURVE = 30.0;  // 0.6 / ground_curve 0.02
const float SUN_ANGLE_MAX = 0.866;    // cos(30 degrees)
const float INV_SUN_CURVE = 22.76;    // 1.6 / pow(sun_curve 0.15, 1.4)

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

float fbm(vec2 p) {
	float total = 0.0;
	float amp = 0.5;
	for (int i = 0; i < 5; i++) {
		total += value_noise(p) * amp;
		p = p * 2.03 + vec2(17.0, 9.0);
		amp *= 0.5;
	}
	return total / 0.96875;
}

void sky() {
	float v_angle = clamp(EYEDIR.y, -1.0, 1.0);
	vec3 sky = mix(sky_top_color.rgb, sky_horizon_color.rgb, clamp(pow(1.0 - v_angle, INV_SKY_CURVE), 0.0, 1.0));
	vec3 sun = vec3(0.0);
	float sun_amount = 0.0;
	if (LIGHT0_ENABLED) {
		float sun_angle = dot(LIGHT0_DIRECTION, EYEDIR);
		float sun_size = cos(LIGHT0_SIZE);
		sun = LIGHT0_COLOR * LIGHT0_ENERGY;
		if (sun_angle > sun_size) {
			sun_amount = 1.0;
		} else if (sun_angle > SUN_ANGLE_MAX) {
			float c2 = (sun_size - sun_angle) / (sun_size - SUN_ANGLE_MAX);
			sun_amount = clamp(pow(1.0 - c2, INV_SUN_CURVE), 0.0, 1.0);
		}
	}

	if (clouds > 0.0 && EYEDIR.y > 0.0) {
		// Clouds on a flat layer overhead: further away toward the horizon, where they thin out.
		vec2 p = EYEDIR.xz / (EYEDIR.y + 0.12) * 1.6 + cloud_offset;
		float d = fbm(p);
		float threshold = mix(0.72, 0.28, clouds);
		float alpha = smoothstep(threshold, threshold + mix(0.22, 0.045, anime), d) * smoothstep(0.0, 0.14, EYEDIR.y);
		// Thicker cloud is darker underneath; the side toward the sun is lit with its colour.
		float thick = clamp((d - threshold) * 2.2, 0.0, 1.0);
		vec3 lit = mix(vec3(1.0), sun, 0.3);
		vec3 shade = mix(sky_horizon_color.rgb, sky_top_color.rgb, 0.35) * 0.82;
		vec3 anime_shade = mix(sky_top_color.rgb, vec3(1.0), 0.55) * vec3(0.93, 0.92, 1.0);
		float shade_amount = mix(thick * 0.75, smoothstep(0.4, 0.48, thick) * 0.85, anime);
		vec3 cloud = mix(lit, mix(shade, anime_shade, anime), shade_amount);
		if (LIGHT0_ENABLED) {
			float toward = max(dot(LIGHT0_DIRECTION, EYEDIR), 0.0);
			cloud += sun * pow(toward, 12.0) * 0.6 * (1.0 - thick);
		}
		sky = mix(sky, cloud, alpha * 0.92);
		sun_amount *= 1.0 - alpha * 0.85;
	}
	sky = mix(sky, sun, sun_amount);

	vec3 ground = mix(ground_bottom_color.rgb, ground_horizon_color.rgb, clamp(pow(1.0 + v_angle, INV_GROUND_CURVE), 0.0, 1.0));
	COLOR = mix(ground, sky, step(0.0, EYEDIR.y));
}
