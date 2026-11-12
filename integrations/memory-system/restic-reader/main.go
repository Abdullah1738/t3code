// A private pipe reader for existing encrypted restic blobs. Never restores files.
package main

import (
	"bufio"
	"container/list"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/restic/restic/internal/backend/local"
	"github.com/restic/restic/internal/repository"
	"github.com/restic/restic/internal/restic"
)

type request struct {
	Password string      `json:"password"`
	IDs      []restic.ID `json:"ids"`
	ID       restic.ID   `json:"id"`
	Offset   int         `json:"offset"`
	Count    int         `json:"count"`
}
type cached struct {
	id   restic.ID
	data []byte
}

func run() error {
	if len(os.Args) != 2 {
		return errors.New("arguments")
	}
	ctx := context.Background()
	in := json.NewDecoder(bufio.NewReader(os.Stdin))
	out := bufio.NewWriter(os.Stdout)
	var init request
	if err := in.Decode(&init); err != nil {
		return err
	}
	config := local.NewConfig()
	config.Path = os.Args[1]
	be, err := local.Open(ctx, config, nil)
	if err != nil {
		return err
	}
	defer be.Close()
	repo, err := repository.New(be, repository.Options{})
	if err != nil {
		return err
	}
	defer repo.Close()
	if err = repo.SearchKey(ctx, init.Password, 0, ""); err != nil {
		return err
	}
	init.Password = ""
	lock, ctx, err := repository.Lock(ctx, repo, false, 0, func(string) {}, func(string, ...interface{}) {})
	if err != nil {
		return err
	}
	defer lock.Unlock()
	if err = repo.LoadIndex(ctx, nil); err != nil {
		return err
	}
	sizes := make([]uint, len(init.IDs))
	for i, id := range init.IDs {
		size, ok := repo.LookupBlobSize(restic.DataBlob, id)
		if !ok || size > 64<<20 {
			return errors.New("blob size")
		}
		sizes[i] = size
	}
	if err = json.NewEncoder(out).Encode(sizes); err != nil {
		return err
	}
	if err = out.Flush(); err != nil {
		return err
	}
	cache := map[restic.ID]*list.Element{}
	order := list.New()
	used := 0
	for {
		var req request
		if err = in.Decode(&req); err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
		if req.Offset < 0 || req.Count < 0 || req.Count > 1<<20 {
			return errors.New("range")
		}
		var value []byte
		if element, ok := cache[req.ID]; ok {
			order.MoveToFront(element)
			value = element.Value.(cached).data
		} else {
			size, ok := repo.LookupBlobSize(restic.DataBlob, req.ID)
			if !ok || size > 64<<20 {
				return errors.New("blob size")
			}
			value, err = repo.LoadBlob(ctx, restic.DataBlob, req.ID, nil)
			if err != nil {
				return err
			}
			for used+len(value) > 32<<20 && order.Len() > 0 {
				element := order.Back()
				item := element.Value.(cached)
				used -= len(item.data)
				delete(cache, item.id)
				order.Remove(element)
			}
			cache[req.ID] = order.PushFront(cached{req.ID, value})
			used += len(value)
		}
		if req.Offset > len(value) || req.Count > len(value)-req.Offset {
			return errors.New("range")
		}
		if err = binary.Write(out, binary.BigEndian, uint32(req.Count)); err != nil {
			return err
		}
		if _, err = out.Write(value[req.Offset : req.Offset+req.Count]); err != nil {
			return err
		}
		if err = out.Flush(); err != nil {
			return err
		}
	}
}

func main() {
	if run() != nil {
		os.Exit(1)
	}
}
