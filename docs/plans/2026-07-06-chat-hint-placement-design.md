# Chat hint placement

The floating trigger hint remains unchanged. The chatbot renders one inline
context hint, anchored immediately above the actual NLUX composer.

Placement uses the measured distance from the chat panel bottom to the
composer's top edge instead of assuming that composer height equals that
distance. Repeated identical hint events refresh the existing hint timer and
timestamp without advancing its render cycle.

Regression coverage verifies that duplicate events produce one chatbot hint
and that the hint sits within a small gap above the composer.
