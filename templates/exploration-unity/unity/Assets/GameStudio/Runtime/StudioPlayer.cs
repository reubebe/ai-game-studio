using UnityEngine;

namespace GameStudio
{
    // Third-person walker. W A S D or arrows move, Shift sprints, Space jumps, hold the right mouse
    // button to look around. The self-test drives it through ScriptedInput instead of the keyboard.
    [RequireComponent(typeof(CharacterController))]
    public class StudioPlayer : MonoBehaviour
    {
        public float speed = 6f;
        public float sprintMultiplier = 1.7f;
        public float jumpVelocity = 5.5f;
        public float cameraDistance = 6f;
        public float gravity = 18f;
        public float yaw;
        public bool controlsEnabled = true;
        public Vector2? ScriptedInput;
        public Vector3 SpawnPoint;

        float pitch = 18f;
        Vector3 velocity;
        CharacterController controller;
        Transform cameraRig;

        public bool Grounded => controller != null && controller.isGrounded;

        public void Init(Transform camera)
        {
            cameraRig = camera;
            controller = GetComponent<CharacterController>();
        }

        public void Teleport(Vector3 position)
        {
            controller.enabled = false;
            transform.position = position;
            velocity = Vector3.zero;
            controller.enabled = true;
        }

        void Update()
        {
            if (controller == null) return;
            Vector2 input = Vector2.zero;
            bool jump = false, sprint = false;
            if (ScriptedInput.HasValue)
            {
                input = ScriptedInput.Value;
            }
            else if (controlsEnabled && !Application.isBatchMode)
            {
                input = new Vector2(Input.GetAxisRaw("Horizontal"), Input.GetAxisRaw("Vertical"));
                jump = Input.GetButtonDown("Jump");
                sprint = Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);
                if (Input.GetMouseButton(1))
                {
                    yaw += Input.GetAxis("Mouse X") * 3f;
                    pitch = Mathf.Clamp(pitch - Input.GetAxis("Mouse Y") * 2f, -10f, 60f);
                }
            }
            Vector3 direction = Quaternion.Euler(0f, yaw, 0f) * new Vector3(input.x, 0f, input.y);
            if (direction.sqrMagnitude > 1f) direction.Normalize();
            float target = speed * (sprint ? sprintMultiplier : 1f);
            velocity.x = direction.x * target;
            velocity.z = direction.z * target;
            if (controller.isGrounded)
            {
                if (velocity.y < 0f) velocity.y = -2f;
                if (jump) velocity.y = jumpVelocity;
            }
            velocity.y -= gravity * Time.deltaTime;
            controller.Move(velocity * Time.deltaTime);
            if (direction.sqrMagnitude > 0.01f) transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(direction), Mathf.Clamp01(Time.deltaTime * 12f));
            if (transform.position.y < -25f) Teleport(SpawnPoint);
        }

        void LateUpdate()
        {
            if (cameraRig == null) return;
            Quaternion look = Quaternion.Euler(pitch, yaw, 0f);
            Vector3 head = transform.position + Vector3.up * 1.6f;
            cameraRig.position = head - look * Vector3.forward * cameraDistance;
            cameraRig.rotation = look;
        }
    }
}
