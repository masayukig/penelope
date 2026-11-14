//go:build !linux

package dns

import "net"

// serveUDPFromDst is Linux's alone: elsewhere queries are answered as they
// come (udp_linux.go).
func (s *Server) serveUDPFromDst(*net.UDPConn) (bool, error) { return false, nil }
