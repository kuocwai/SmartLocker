import { useRef, useState } from 'react'
import { Text, useCursor } from '@react-three/drei'
import * as THREE from 'three'

const STATUS_COLORS = {
  available: '#16a34a', // Emerald / Green
  reserved: '#d97706',  // Amber / Orange
  occupied: '#dc2626',  // Red
}

function LockerDoor({ position, locker, onClick }) {
  const [hovered, setHovered] = useState(false)
  const isAvailable = locker.status === 'available'

  useCursor(hovered && isAvailable, 'pointer', 'auto')

  const baseColor = STATUS_COLORS[locker.status] || '#64748b'
  
  // Hiệu ứng phát sáng nhẹ khi hover vào tủ trống
  const emissiveColor = hovered && isAvailable 
    ? new THREE.Color(baseColor).multiplyScalar(0.4) 
    : new THREE.Color('#000000')

  const handleClick = (e) => {
    e.stopPropagation()
    if (isAvailable) {
      onClick(locker.id)
    }
  }

  return (
    <group position={position}>
      {/* Khối thân trong của ngăn tủ */}
      <mesh>
        <boxGeometry args={[1.2, 1.2, 1]} />
        <meshStandardMaterial 
          color="#334155"
          metalness={0.6}
          roughness={0.4}
        />
      </mesh>

      {/* Cánh cửa tủ (Door Panel) */}
      <mesh 
        position={[0, 0, 0.52]}
        onClick={handleClick}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
        onPointerOut={(e) => { e.stopPropagation(); setHovered(false); }}
      >
        <boxGeometry args={[1.12, 1.12, 0.05]} />
        <meshStandardMaterial 
          color={baseColor}
          metalness={0.3}
          roughness={0.5}
          emissive={emissiveColor}
        />
      </mesh>

      {/* Tay nắm & Khóa điện tử (Handle bar) */}
      <mesh position={[0.42, 0, 0.56]}>
        <boxGeometry args={[0.06, 0.4, 0.03]} />
        <meshStandardMaterial color="#0f172a" metalness={0.9} roughness={0.2} />
      </mesh>

      {/* Khe thông gió (Vent lines) */}
      <mesh position={[0, -0.38, 0.55]}>
        <boxGeometry args={[0.5, 0.02, 0.01]} />
        <meshStandardMaterial color="#0f172a" roughness={0.8} />
      </mesh>
      <mesh position={[0, -0.42, 0.55]}>
        <boxGeometry args={[0.5, 0.02, 0.01]} />
        <meshStandardMaterial color="#0f172a" roughness={0.8} />
      </mesh>

      {/* Số hiệu ngăn tủ */}
      <Text
        position={[0, 0.18, 0.56]}
        fontSize={0.26}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
      >
        {locker.label}
      </Text>

      {/* Đèn LED trạng thái tròn */}
      <mesh position={[0, -0.1, 0.56]}>
        <circleGeometry args={[0.075, 32]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
    </group>
  )
}

export default function LockerStation({ lockers = [], onLockerClick }) {
  // Bố cục lưới 2x2
  const positions = [
    [-0.65, 0.65, 0],  // Hàng trên - Trái (Tủ 1)
    [0.65, 0.65, 0],   // Hàng trên - Phải (Tủ 2)
    [-0.65, -0.65, 0], // Hàng dưới - Trái (Tủ 3)
    [0.65, -0.65, 0],  // Hàng dưới - Phải (Tủ 4)
  ]

  return (
    <group>
      {/* Khung trạm tủ chính (Cabinet Outer Frame) */}
      <mesh position={[0, 0, -0.05]}>
        <boxGeometry args={[2.84, 2.84, 1.1]} />
        <meshStandardMaterial color="#0f172a" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Chân đế trạm tủ (Heavy Base Stand) */}
      <mesh position={[0, -1.48, 0]}>
        <boxGeometry args={[3.2, 0.14, 1.4]} />
        <meshStandardMaterial color="#020617" metalness={0.9} roughness={0.2} />
      </mesh>

      {/* Mái vòm nóc trạm tủ (Roof Kiosk Header) */}
      <mesh position={[0, 1.58, 0]}>
        <boxGeometry args={[3.1, 0.3, 1.2]} />
        <meshStandardMaterial color="#1e293b" metalness={0.8} roughness={0.3} />
      </mesh>

      {/* Viền viền cam FPT trên nóc */}
      <mesh position={[0, 1.73, 0]}>
        <boxGeometry args={[3.1, 0.02, 1.2]} />
        <meshBasicMaterial color="#ea580c" />
      </mesh>

      {/* Tên thương hiệu 3D trên nóc: TRẠM GIỮ HÀNG HÓA FPT */}
      <Text
        position={[0, 1.58, 0.62]}
        fontSize={0.17}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.04}
      >
        TRẠM GIỮ HÀNG HÓA FPT
      </Text>

      {/* 4 Ngăn tủ */}
      {lockers.slice(0, 4).map((locker, index) => (
        <LockerDoor
          key={locker.id}
          position={positions[index]}
          locker={locker}
          onClick={onLockerClick}
        />
      ))}
    </group>
  )
}
