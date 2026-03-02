import React, { useEffect } from "react";
import { motion } from "framer-motion";
import { logger } from "../utils/logger";

interface WindowControlsProps {
  currentPhase:
    | "idle"
    | "generating"
    | "executing"
    | "fixing"
    | "completed"
    | "error";
}

/**
 * WindowControls - Animated macOS-style window control dots
 * Responds to AI state with subtle professional animations
 */
export const WindowControls: React.FC<WindowControlsProps> = ({
  currentPhase,
}) => {
  // Determine animation states based on current phase
  const isGenerating = currentPhase === "generating";
  const isExecuting = currentPhase === "executing";
  const isHealing = currentPhase === "fixing";
  const hasError = currentPhase === "error";

  // Debug logging
  useEffect(() => {
    logger.debug("WindowControls phase changed", {
      component: "WindowControls",
      data: { currentPhase, isGenerating, isExecuting, isHealing, hasError },
    });
  }, [currentPhase, isGenerating, isExecuting, isHealing, hasError]);

  // Staggered bounce animation for generating state (wave effect)
  const bounceVariants = {
    idle: { y: 0 },
    bounce: {
      y: [0, -6, 0],
    },
  };

  // Slow pulse animation for executing state
  const slowPulseVariants = {
    idle: { scale: 1 },
    pulse: {
      scale: [1, 1.15, 1],
    },
  };

  // Rapid blink animation for healing state (self-correction)
  const rapidBlinkVariants = {
    idle: { opacity: 1 },
    blink: {
      opacity: [1, 0.3, 1],
    },
  };

  // Shake animation for error state
  const shakeVariants = {
    idle: { x: 0 },
    shake: {
      x: [-3, 3, -3, 3, 0],
    },
  };

  // Hover animation for all dots
  const hoverAnimation = {
    scale: 1.15,
    filter: "brightness(1.3)",
    transition: { duration: 0.2 },
  };

  return (
    <div className="flex items-center gap-2">
      {/* Red Dot - Animates on error or during generating (wave) */}
      <motion.div
        className="w-3 h-3 rounded-full bg-red-500 cursor-pointer"
        variants={hasError ? shakeVariants : bounceVariants}
        animate={hasError ? "shake" : isGenerating ? "bounce" : "idle"}
        whileHover={hoverAnimation}
        transition={{
          duration: hasError ? 0.4 : 0.6,
          ease: "easeInOut",
          repeat: hasError || isGenerating ? Infinity : 0,
          repeatDelay: hasError ? 1 : 0,
          delay: isGenerating && !hasError ? 0 : 0,
        }}
      />

      {/* Yellow Dot - Animates during executing (slow pulse), healing (rapid blink), or generating (wave) */}
      <motion.div
        className="w-3 h-3 rounded-full bg-yellow-500 cursor-pointer"
        variants={
          isHealing
            ? rapidBlinkVariants
            : isExecuting
              ? slowPulseVariants
              : bounceVariants
        }
        animate={
          isHealing
            ? "blink"
            : isExecuting
              ? "pulse"
              : isGenerating
                ? "bounce"
                : "idle"
        }
        whileHover={hoverAnimation}
        transition={{
          duration: isHealing ? 0.3 : isExecuting ? 2 : 0.6,
          ease: "easeInOut",
          repeat: isHealing || isExecuting || isGenerating ? Infinity : 0,
          delay: isGenerating && !isHealing && !isExecuting ? 0.1 : 0,
        }}
      />

      {/* Green Dot - Animates during generating (wave) */}
      <motion.div
        className="w-3 h-3 rounded-full bg-green-500 cursor-pointer"
        variants={bounceVariants}
        animate={isGenerating ? "bounce" : "idle"}
        whileHover={hoverAnimation}
        transition={{
          duration: 0.6,
          ease: "easeInOut",
          repeat: isGenerating ? Infinity : 0,
          delay: isGenerating ? 0.2 : 0,
        }}
      />
    </div>
  );
};
