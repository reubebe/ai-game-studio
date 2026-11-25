// A photographed sky (a .hdr panorama from the free library's Skies), as photographed times its
// brightness. Godot's web renderer (Compatibility) treats a sky shader's colour as screen colours and
// converts it to light values afterwards, which is right for colour settings but darkens a photo's light
// values a second time (measured against Poly Haven's own preview: (16, 41, 83) where it shows about
// (72, 98, 149)). There the light values are written in screen colours first, so the conversion gives
// them back (world_builder.gd sets encode_srgb on that renderer only).
shader_type sky;

uniform sampler2D panorama : filter_linear, repeat_enable, hint_default_black;
uniform float energy = 1.0;
uniform bool encode_srgb = false;

void sky() {
	vec3 c = texture(panorama, SKY_COORDS).rgb * energy;
	if (encode_srgb) {
		c = mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, lessThan(c, vec3(0.0031308)));
	}
	COLOR = c;
}
